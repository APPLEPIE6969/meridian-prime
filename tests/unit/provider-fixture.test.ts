import { beforeEach, describe, expect, it } from 'vitest'
import { fixtureProvider, resetFixtureCache } from '@/lib/provider/fixture'
import { SYMBOLS, UNIVERSE } from '@/lib/universe'

beforeEach(() => {
  resetFixtureCache()
})

describe('fixture provider', () => {
  it('serves the whole universe from recorded real payloads', async () => {
    const quotes = await fixtureProvider.getQuotes(SYMBOLS)
    expect(quotes.length).toBe(UNIVERSE.length)
    for (const quote of quotes) {
      expect(quote.last).toBeGreaterThan(0)
      expect(quote.bid).toBeLessThan(quote.ask)
    }
  })

  it('serves single quotes case-insensitively', async () => {
    const q = await fixtureProvider.getQuote('aapl')
    expect(q).not.toBeNull()
    expect(q!.symbol).toBe('AAPL')
    expect(await fixtureProvider.getQuote('NOPE')).toBeNull()
  })

  it('serves real AAPL minute bars', async () => {
    const bars = await fixtureProvider.getMinuteBars('AAPL')
    expect(bars.length).toBeGreaterThan(100)
    expect(await fixtureProvider.getMinuteBars('MSFT')).toEqual([])
  })

  it('serves real daily history for recorded symbols and synthetic for the rest', async () => {
    const aapl = await fixtureProvider.getDailyHistory('AAPL')
    expect(aapl.length).toBeGreaterThan(1000)
    const msft = await fixtureProvider.getDailyHistory('MSFT')
    expect(msft.length).toBeGreaterThan(1000)
    const synthetic = await fixtureProvider.getDailyHistory('XLE')
    expect(synthetic.length).toBe(390)
    for (let i = 1; i < synthetic.length; i++) {
      expect(synthetic[i].t).toBeGreaterThan(synthetic[i - 1].t)
    }
  })

  it('serves recorded AAPL dividend events', async () => {
    const divs = await fixtureProvider.getDividends('AAPL')
    expect(divs.length).toBeGreaterThan(0)
    expect((await fixtureProvider.getDividends('KO')).length).toBe(0)
  })

  it('filters news by requested symbols', async () => {
    const all = await fixtureProvider.getNews(['AAPL'])
    expect(all.length).toBeGreaterThan(0)
    for (const item of all) {
      expect(item.symbols).toContain('AAPL')
    }
    expect((await fixtureProvider.getNews(['TSLA'])).length).toBe(0)
  })

  it('reports its name', () => {
    expect(fixtureProvider.name).toBe('fixture')
  })
})
