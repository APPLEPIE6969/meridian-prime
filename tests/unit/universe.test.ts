import { describe, expect, it } from 'vitest'
import { SECTORS, SYMBOLS, UNIVERSE, getInstrument, isListed, normalizeSymbol } from '@/lib/universe'

describe('tradable universe', () => {
  it('holds 42 operating companies and one ETF per sector', () => {
    const stocks = UNIVERSE.filter((i) => i.kind === 'stock')
    const etfs = UNIVERSE.filter((i) => i.kind === 'etf')
    expect(stocks.length).toBe(42)
    expect(etfs.length).toBe(SECTORS.length)
    expect(UNIVERSE.length).toBe(51)
  })

  it('covers nine sectors with at least one stock and its ETF each', () => {
    expect(SECTORS.length).toBe(9)
    for (const sector of SECTORS) {
      const inSector = UNIVERSE.filter((i) => i.sector === sector)
      expect(inSector.some((i) => i.kind === 'stock'), sector).toBe(true)
      expect(inSector.filter((i) => i.kind === 'etf').length, sector).toBe(1)
    }
  })

  it('has unique, correctly-formatted symbols', () => {
    const set = new Set(SYMBOLS)
    expect(set.size).toBe(SYMBOLS.length)
    for (const symbol of SYMBOLS) {
      expect(symbol).toMatch(/^[A-Z]{1,5}$/)
    }
  })

  it('resolves instruments case-insensitively', () => {
    expect(getInstrument('aapl')?.symbol).toBe('AAPL')
    expect(isListed('msft')).toBe(true)
    expect(isListed('ZZZZ')).toBe(false)
    expect(normalizeSymbol(' aapl ')).toBe('AAPL')
  })

  it('includes real household names', () => {
    for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'LLY', 'XOM']) {
      expect(isListed(symbol), symbol).toBe(true)
    }
  })
})
