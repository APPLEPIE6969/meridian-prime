// Robinhood adapter — parser + integration against recorded real payloads
// (tests/fixtures/robinhood-*.json, captured live during market hours).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { robinhoodProvider, parseRhQuote, type RhQuoteRow, type RhFundamentalRow } from '@/lib/provider/robinhood'
import { repoPath } from '@/lib/paths'
import fs from 'node:fs'

const batch = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'robinhood-batch.json'), 'utf8'))
const funds = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'robinhood-fund.json'), 'utf8'))
const single = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'robinhood-AAPL.json'), 'utf8'))

const aaplRow: RhQuoteRow = batch.results[0]
const aaplFund: RhFundamentalRow = funds.results[0]

beforeEach(() => {
  process.env.MERIDIAN_DATA_PROVIDER = 'yahoo'
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env.MERIDIAN_DATA_PROVIDER = 'fixture'
})

describe('robinhood quote parser (pure)', () => {
  it('maps a real quote + fundamentals row to a full Quote', () => {
    const q = parseRhQuote(aaplRow, aaplFund)
    expect(q).not.toBeNull()
    expect(q!.symbol).toBe('AAPL')
    expect(q!.last).toBeCloseTo(Number(aaplRow.last_trade_price), 2)
    // Real venue top of book, not synthesized.
    expect(q!.bid).toBeCloseTo(Number(aaplRow.bid_price), 2)
    expect(q!.ask).toBeCloseTo(Number(aaplRow.ask_price), 2)
    expect(q!.ask).toBeGreaterThan(q!.bid)
    expect(q!.prevClose).toBeCloseTo(Number(aaplRow.previous_close), 2)
    // Day fields hydrated from fundamentals.
    expect(q!.dayHigh).toBeCloseTo(Number(aaplFund.high), 2)
    expect(q!.dayLow).toBeCloseTo(Number(aaplFund.low), 2)
    expect(q!.dayVolume).toBe(Math.floor(Number(aaplFund.volume)))
    expect(q!.ts).toBe(Date.parse(aaplRow.updated_at!))
  })

  it('rejects halted symbols and rows without a symbol or price', () => {
    expect(parseRhQuote({ ...aaplRow, trading_halted: true }, aaplFund)).toBeNull()
    expect(parseRhQuote({ last_trade_price: '10' }, undefined)).toBeNull()
    expect(parseRhQuote({ symbol: 'AAPL', last_trade_price: null, last_extended_hours_trade_price: null }, undefined)).toBeNull()
    expect(parseRhQuote({ symbol: 'AAPL', last_trade_price: '0' }, undefined)).toBeNull()
  })

  it('falls back to the extended-hours print when the regular last is absent', () => {
    const q = parseRhQuote({ ...aaplRow, last_trade_price: null, last_extended_hours_trade_price: '331.2500' }, aaplFund)
    expect(q!.last).toBe(331.25)
  })

  it('synthesizes the book when the venue prints no two-sided market', () => {
    const q = parseRhQuote({ ...aaplRow, bid_price: '0', ask_price: '0', bid_size: null, ask_size: null }, undefined)
    expect(q).not.toBeNull()
    expect(q!.bid).toBeLessThan(q!.last)
    expect(q!.ask).toBeGreaterThan(q!.last)
    expect(q!.bidSize).toBeGreaterThanOrEqual(100) // synth default size floor
    // No fundamentals: day bounds bracket the known prints, volume unknown.
    expect(q!.dayHigh).toBe(Math.max(q!.last, q!.prevClose))
    expect(q!.dayLow).toBe(Math.min(q!.last, q!.prevClose))
    expect(q!.dayVolume).toBe(0)
  })

  it('derives prevClose from last when the row omits it', () => {
    const q = parseRhQuote({ symbol: 'ZZZ', last_trade_price: '12.345' }, undefined)
    expect(q!.prevClose).toBe(12.35)
    expect(q!.ts).toBeGreaterThan(0) // wall-clock fallback
  })

  it('defaults book sizes to the venue minimum when the row omits them', () => {
    const q = parseRhQuote({ ...aaplRow, bid_size: null, ask_size: null }, aaplFund)
    expect(q!.bid).toBeCloseTo(Number(aaplRow.bid_price), 2) // two-sided book kept
    expect(q!.bidSize).toBe(100)
    expect(q!.askSize).toBe(100)
  })
})

describe('robinhood adapter over a stubbed fetch', () => {
  function stubFetch(opts: { fundMode: 'ok' | 'reject' | 'short' }) {
    vi.stubGlobal('fetch', (url: string | URL) => {
      const u = String(url)
      if (u.includes('/quotes/?symbols=')) {
        const requested = decodeURIComponent(u.split('symbols=')[1]).split(',')
        const rows = (batch.results as Array<RhQuoteRow>).filter((r) => requested.includes(r.symbol!))
        return Promise.resolve(new Response(JSON.stringify({ results: rows }), { status: 200 }))
      }
      if (u.includes('/fundamentals/?symbols=')) {
        if (opts.fundMode === 'reject') return Promise.reject(new Error('fundamentals down'))
        const requested = decodeURIComponent(u.split('symbols=')[1]).split(',')
        const rows = (funds.results as Array<RhFundamentalRow | null>).filter(
          (_r, i) => opts.fundMode === 'short' ? i < 1 : requested.includes((batch.results as Array<RhQuoteRow>)[i].symbol!),
        )
        return Promise.resolve(new Response(JSON.stringify({ results: rows }), { status: 200 }))
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    })
  }

  it('serves the universe from quotes + fundamentals in two batched calls', async () => {
    stubFetch({ fundMode: 'ok' })
    const quotes = await robinhoodProvider.getQuotes(['AAPL', 'MSFT'])
    expect(quotes.length).toBe(2)
    const aapl = quotes.find((q) => q.symbol === 'AAPL')!
    expect(aapl.dayVolume).toBeGreaterThan(1_000_000)
    expect(aapl.dayHigh).toBeGreaterThan(aapl.dayLow)
    expect(aapl.bid).toBeGreaterThan(0)
    expect(await robinhoodProvider.getQuotes([])).toEqual([]) // nothing requested, nothing fetched
  })

  it('degrades to synthesized day bounds when fundamentals are unavailable', async () => {
    stubFetch({ fundMode: 'reject' })
    const quotes = await robinhoodProvider.getQuotes(['AAPL'])
    expect(quotes.length).toBe(1)
    expect(quotes[0].dayVolume).toBe(0)
    expect(quotes[0].dayHigh).toBe(Math.max(quotes[0].last, quotes[0].prevClose))
  })

  it('ignores fundamentals that drift out of alignment with the request', async () => {
    stubFetch({ fundMode: 'short' })
    const quotes = await robinhoodProvider.getQuotes(['AAPL', 'MSFT'])
    expect(quotes.length).toBe(2)
    for (const q of quotes) {
      expect(q.dayVolume).toBe(0) // unaligned fundamentals are not trusted
      expect(q.dayHigh).toBe(Math.max(q.last, q.prevClose))
    }
  })

  it('drops null rows the venue returns', async () => {
    stubFetch({ fundMode: 'ok' })
    vi.stubGlobal('fetch', (url: string | URL) => {
      const u = String(url)
      if (u.includes('/quotes/?symbols=')) {
        return Promise.resolve(new Response(JSON.stringify({ results: [null, aaplRow] }), { status: 200 }))
      }
      if (u.includes('/fundamentals/?symbols=')) {
        return Promise.resolve(new Response(JSON.stringify({ results: [aaplFund] }), { status: 200 }))
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    })
    const quotes = await robinhoodProvider.getQuotes(['AAPL'])
    expect(quotes.length).toBe(1)
    expect(quotes[0].symbol).toBe('AAPL')
  })

  it('serves a single quote and honest empty series for everything else', async () => {
    stubFetch({ fundMode: 'ok' })
    const q = await robinhoodProvider.getQuote('AAPL')
    expect(q!.symbol).toBe('AAPL')
    expect(await robinhoodProvider.getMinuteBars('AAPL')).toEqual([])
    expect(await robinhoodProvider.getDailyHistory('AAPL')).toEqual([])
    expect(await robinhoodProvider.getDividends('AAPL')).toEqual([])
    expect(await robinhoodProvider.getNews(['AAPL'])).toEqual([])
  })

  it('serves null when the venue does not quote the requested symbol', async () => {
    stubFetch({ fundMode: 'ok' })
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })))
    expect(await robinhoodProvider.getQuote('NOPE')).toBeNull()
  })

  it('treats a response without a results key as an empty book', async () => {
    stubFetch({ fundMode: 'ok' })
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ detail: 'Not found.' }), { status: 200 })))
    expect(await robinhoodProvider.getQuotes(['AAPL'])).toEqual([])
  })
})
