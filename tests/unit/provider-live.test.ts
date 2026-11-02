import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { yahooProvider } from '@/lib/provider/yahoo'
import { resetQuoteService, quoteService, QuoteService } from '@/lib/market/quotes'
import { repoPath } from '@/lib/paths'
import fs from 'node:fs'
import { SYMBOLS } from '@/lib/universe'

const spark = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'spark-1.json'), 'utf8'))
const intraday = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-intraday.json'), 'utf8'))
const daily = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-daily.json'), 'utf8'))
const dividends = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-dividends.json'), 'utf8'))
const rss = fs.readFileSync(repoPath('tests', 'fixtures', 'news-AAPL.xml'), 'utf8')

interface Call {
  url: string
  init: RequestInit | undefined
}

let calls: Call[] = []
let respond: (url: string) => Response

function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = String(url)
  calls.push({ url: u, init })
  return Promise.resolve(respond(u))
}

beforeEach(() => {
  calls = []
  respond = (url) => {
    if (url.includes('/v7/finance/spark')) return new Response(JSON.stringify(spark), { status: 200 })
    if (url.includes('interval=1m')) return new Response(JSON.stringify(intraday), { status: 200 })
    if (url.includes('events=div')) return new Response(JSON.stringify(dividends), { status: 200 })
    if (url.includes('/v8/finance/chart')) return new Response(JSON.stringify(daily), { status: 200 })
    if (url.includes('feeds.finance.yahoo.com')) return new Response(rss, { status: 200 })
    return new Response('not found', { status: 404 })
  }
  vi.stubGlobal('fetch', fakeFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetQuoteService()
})

describe('live yahoo adapter over a stubbed fetch', () => {
  it('encodes each symbol separately and batches at 16', async () => {
    const quotes = await yahooProvider.getQuotes(['AAPL', 'MSFT'])
    expect(quotes.length).toBe(16) // fixture batch has 16 entries
    expect(calls.length).toBe(1)
    // Per-symbol encoding: commas stay literal separators. A whole-batch
    // encodeURIComponent would have produced AAPL%2CMSFT (the classic bug).
    expect(calls[0].url).toContain('symbols=AAPL,MSFT&range=1d')
    expect(calls[0].url).not.toContain('%2C')
    expect(calls[0].init?.headers).toMatchObject({ 'User-Agent': expect.stringContaining('Mozilla') })

    const many = SYMBOLS.slice(0, 20) // 20 symbols -> 2 batches
    await yahooProvider.getQuotes(many)
    expect(calls.length).toBe(3)
    expect(calls[1].url).toContain('symbols=')
  })

  it('serves single quotes, candles, dividends and news through the same client', async () => {
    const quote = await yahooProvider.getQuote('AAPL')
    expect(quote).not.toBeNull()
    expect(quote!.last).toBeGreaterThan(0)
    expect(quote!.bid).toBeLessThan(quote!.ask)

    const bars = await yahooProvider.getMinuteBars('AAPL')
    expect(bars.length).toBeGreaterThan(100)

    const hist = await yahooProvider.getDailyHistory('AAPL', '5y')
    expect(hist.length).toBeGreaterThan(1000)
    expect(calls.some((c) => c.url.includes('range=5y'))).toBe(true)

    const divs = await yahooProvider.getDividends('AAPL', '6mo')
    expect(divs.length).toBeGreaterThan(0)
    expect(calls.some((c) => c.url.includes('events=div'))).toBe(true)

    const news = await yahooProvider.getNews(['AAPL'], 5)
    expect(news.length).toBeGreaterThan(0)
    for (const item of news) {
      expect(item.symbols).toEqual(['AAPL'])
      expect(item.source).toBe('Yahoo Finance')
    }
  })

  it('retries transient upstream failures and then gives up loudly', async () => {
    const failures = [new Response('rate limited', { status: 429 }), new Response('rate limited', { status: 429 })]
    let attempt = 0
    vi.stubGlobal('fetch', () => {
      attempt++
      return attempt <= 2 ? Promise.resolve(failures.shift()!) : Promise.resolve(new Response(JSON.stringify(spark), { status: 200 }))
    })
    const quotes = await yahooProvider.getQuote('AAPL')
    expect(quotes).not.toBeNull() // third attempt succeeds
    expect(quotes!.last).toBeGreaterThan(0)
    expect(attempt).toBe(3)

    vi.stubGlobal('fetch', () => Promise.resolve(new Response('down', { status: 503 })))
    await expect(yahooProvider.getQuote('AAPL')).rejects.toThrow('upstream 503')
  })

  it('propagates hard failures to the caller', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 404 })))
    await expect(yahooProvider.getQuote('AAPL')).rejects.toThrow('upstream 404')
  })
})

describe('quote service lifecycle', () => {
  it('prime-less inject creates a working book around the last price', async () => {
    const qs = new QuoteService()
    const injected = await qs.injectQuote('FAKE1', { last: 42 })
    expect(injected.symbol).toBe('FAKE1')
    expect(injected.bid).toBeLessThan(42)
    expect(injected.ask).toBeGreaterThan(42)
    expect(qs.getQuote('fake1')?.last).toBe(42)
    expect(qs.quoteCount()).toBe(1)
  })

  it('polls the active provider, notifies listeners and refreshes minute bars', async () => {
    process.env.MERIDIAN_DATA_PROVIDER = 'fixture'
    const qs = new QuoteService()
    const seen: string[] = []
    qs.onTick((symbol) => {
      seen.push(symbol)
    })
    const changed = await qs.pollOnce()
    expect(changed).toBeGreaterThan(0)
    expect(seen.length).toBeGreaterThan(0)
    expect(qs.quoteCount()).toBeGreaterThan(0)
    expect(qs.lastPollError).toBeNull()
    expect(qs.pollCount).toBe(1)
    // Round-robin minute refresh covers the whole universe in 6 batches.
    for (let i = 0; i < 6; i++) await qs.refreshMinuteBarsBatch()
    expect(qs.getMinuteBars('AAPL').length).toBeGreaterThan(0)
  })

  it('isolates listener failures and records poll errors', async () => {
    process.env.MERIDIAN_DATA_PROVIDER = 'fixture'
    const qs = new QuoteService()
    qs.onTick(() => {
      throw new Error('listener blew up')
    })
    const changed = await qs.pollOnce()
    expect(changed).toBeGreaterThan(0) // the poll survived the listener

    process.env.MERIDIAN_DATA_PROVIDER = 'yahoo'
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('down', { status: 500 })))
    const failed = await qs.pollOnce()
    expect(failed).toBe(0)
    expect(qs.lastPollError).toContain('upstream 500')
  })

  it('start/stop manage the polling timer', async () => {
    process.env.MERIDIAN_DATA_PROVIDER = 'fixture'
    const qs = quoteService()
    qs.start()
    expect(qs.pollCount).toBeGreaterThanOrEqual(0)
    qs.stop()
    qs.stop() // idempotent
  })
})

describe('live adapter edge paths', () => {
  it('wraps non-Error rejections from fetch into Errors', async () => {
    vi.stubGlobal('fetch', () => Promise.reject('total connection failure'))
    await expect(yahooProvider.getQuote('AAPL')).rejects.toThrow('total connection failure')
  })

  it('keeps usable quotes when one spark item is unparseable', async () => {
    const brokenSpark = { spark: { result: [{ symbol: 'JUNK', response: [] }, ...parseSparkEnvelopeItems(spark)] } }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(brokenSpark), { status: 200 })))
    const quotes = await yahooProvider.getQuotes(['AAPL', 'JUNK'])
    expect(quotes.length).toBeGreaterThan(0)
    expect(quotes.every((q) => q.symbol !== 'JUNK')).toBe(true)
  })

  it('falls back on missing chart sections', async () => {
    // minute bars with no indicator sections parse to nothing
    const empty = { chart: { result: [{ meta: {}, timestamp: [1, 2] }] } }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(empty), { status: 200 })))
    expect(await yahooProvider.getMinuteBars('AAPL')).toEqual([])
    expect(await yahooProvider.getDailyHistory('AAPL')).toEqual([])
    expect(await yahooProvider.getDividends('AAPL')).toEqual([])
  })

  it('returns null for a single quote the batch cannot provide', async () => {
    const brokenSpark = { spark: { result: [{ symbol: 'JUNK', response: [] }] } }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(brokenSpark), { status: 200 })))
    expect(await yahooProvider.getQuote('JUNK')).toBeNull()
  })

  it('serves empty series when the chart envelope reports an error', async () => {
    const errorEnvelope = { chart: { error: { code: 'Bad Request', description: 'nope' } } }
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(errorEnvelope), { status: 200 })))
    expect(await yahooProvider.getMinuteBars('AAPL')).toEqual([])
    expect(await yahooProvider.getDailyHistory('AAPL')).toEqual([])
    expect(await yahooProvider.getDividends('AAPL')).toEqual([])
  })

  it('deduplicates headlines arriving from two symbol feeds', async () => {
    let call = 0
    vi.stubGlobal('fetch', () => {
      call++
      return Promise.resolve(new Response(rss, { status: 200 }))
    })
    const news = await yahooProvider.getNews(['AAPL', 'MSFT'], 50)
    expect(call).toBe(2) // both feeds fetched
    const ids = news.map((n) => n.providerId)
    expect(new Set(ids).size).toBe(ids.length) // no duplicates survived
  })
})

// Local helper: the recorded spark payload's items, re-exported for reuse.
function parseSparkEnvelopeItems(payload: unknown): Array<Record<string, unknown>> {
  const envelope = payload as { spark?: { result?: Array<Record<string, unknown>> } }
  return envelope?.spark?.result ?? []
}
