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

// ── fixture seams and corruption handling (100% coverage pass) ──────────────

import fs from 'node:fs'
import { setFixtureOverrides } from '@/lib/provider/fixture'
import { repoPath } from '@/lib/paths'
import type { Quote } from '@/lib/provider/types'

function backupAndRestore(files: Array<{ name: string; mode?: 'remove' | 'content'; content?: string }>): {
  corrupt(): void
  restore(): void
} {
  const backups = files.map((f) => {
    const path = repoPath('tests', 'fixtures', f.name)
    return { path, existed: fs.existsSync(path), content: fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '', mode: fs.existsSync(path) ? fs.statSync(path).mode & 0o777 : 0o644 }
  })
  return {
    corrupt() {
      for (const f of files) {
        const path = repoPath('tests', 'fixtures', f.name)
        if (f.mode === 'remove') fs.rmSync(path, { force: true })
        else fs.writeFileSync(path, f.content ?? '', 'utf8')
      }
    },
    restore() {
      for (const b of backups) {
        if (!b.existed) {
          fs.rmSync(b.path, { force: true })
          continue
        }
        fs.writeFileSync(b.path, b.content, 'utf8')
        fs.chmodSync(b.path, b.mode)
      }
    },
  }
}

describe('fixture overrides', () => {
  it('drops in replacement quote lists and intraday series', async () => {
    const replacement: Quote[] = [{
      symbol: 'TEST', last: 7, bid: 6.99, ask: 7.01, bidSize: 1, askSize: 1,
      prevClose: 7, dayHigh: 7.5, dayLow: 6.5, dayVolume: 1000, ts: Date.now(),
    }]
    setFixtureOverrides({ quotes: replacement, aaplIntraday: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }] })
    expect(await fixtureProvider.getQuote('TEST')).toMatchObject({ last: 7 })
    expect(await fixtureProvider.getQuote('AAPL')).toBeNull() // replaced, not merged
    expect((await fixtureProvider.getMinuteBars('AAPL')).length).toBe(1)
  })
})

describe('fixture corruption handling', () => {
  it('skips unreadable and malformed spark files without crashing', async () => {
    const guard = backupAndRestore([
      { name: 'spark-1.json', mode: 'remove' },
      { name: 'spark-2.json', mode: 'content', content: '{ this is not json' },
      { name: 'spark-3.json', mode: 'content', content: JSON.stringify({ spark: { result: [{ symbol: 'X', response: [] }] } }) },
    ])
    guard.corrupt()
    try {
      resetFixtureCache()
      const quotes = await fixtureProvider.getQuotes(SYMBOLS)
      // spark-1 missing, spark-2 unreadable, spark-3 item unparseable → spark-4 only.
      expect(quotes.length).toBeGreaterThan(0)
      expect(quotes.length).toBeLessThan(UNIVERSE.length)
      expect(quotes.every((q) => q.symbol !== 'X')).toBe(true)
    } finally {
      guard.restore()
      resetFixtureCache()
    }
  })

  it('falls back to synthetic history when a chart fixture is missing or malformed', async () => {
    const guard = backupAndRestore([
      { name: 'chart-MSFT-daily.json', mode: 'remove' },
      { name: 'chart-NVDA-daily.json', mode: 'content', content: '{}' },
    ])
    guard.corrupt()
    try {
      resetFixtureCache()
      const msft = await fixtureProvider.getDailyHistory('MSFT')
      expect(msft.length).toBe(390) // synthetic walk replaces the missing file
      const nvda = await fixtureProvider.getDailyHistory('NVDA')
      expect(nvda.length).toBe(390) // synthetic walk replaces the empty envelope
    } finally {
      guard.restore()
      resetFixtureCache()
    }
  })

  it('returns no dividends when the dividend envelope is malformed', async () => {
    const guard = backupAndRestore([{ name: 'chart-AAPL-dividends.json', mode: 'content', content: '{}' }])
    guard.corrupt()
    try {
      resetFixtureCache()
      expect(await fixtureProvider.getDividends('AAPL')).toEqual([])
    } finally {
      guard.restore()
      resetFixtureCache()
    }
  })

  it('falls back to a default-priced synthetic walk without a quote anchor', async () => {
    const guard = backupAndRestore([
      { name: 'spark-1.json', mode: 'remove' },
      { name: 'spark-2.json', mode: 'remove' },
      { name: 'spark-3.json', mode: 'remove' },
      { name: 'chart-MSFT-daily.json', mode: 'remove' },
    ])
    guard.corrupt()
    try {
      resetFixtureCache()
      // MSFT has no recorded daily file and no spark quote left -> the
      // synthetic walk anchors at the $100 default.
      const bars = await fixtureProvider.getDailyHistory('MSFT')
      expect(bars.length).toBe(390)
      // A symbol with neither daily data nor a quote uses the same default.
      const unknown = await fixtureProvider.getDailyHistory('ZZZZ')
      expect(unknown.length).toBe(390)
    } finally {
      guard.restore()
      resetFixtureCache()
    }
  })

  it('returns no dividends when the dividend fixture is missing', async () => {
    const guard = backupAndRestore([{ name: 'chart-AAPL-dividends.json', mode: 'remove' }])
    guard.corrupt()
    try {
      resetFixtureCache()
      expect(await fixtureProvider.getDividends('AAPL')).toEqual([])
    } finally {
      guard.restore()
      resetFixtureCache()
    }
  })

  it('returns no news when the RSS file is missing', async () => {
    const guard = backupAndRestore([{ name: 'news-AAPL.xml', mode: 'remove' }])
    guard.corrupt()
    try {
      resetFixtureCache()
      expect(await fixtureProvider.getNews(['AAPL'])).toEqual([])
    } finally {
      guard.restore()
      resetFixtureCache()
    }
  })

  it('returns no news when the RSS file cannot be read', async () => {
    const path = repoPath('tests', 'fixtures', 'news-AAPL.xml')
    const original = fs.readFileSync(path, 'utf8')
    const originalMode = fs.statSync(path).mode & 0o777
    fs.chmodSync(path, 0o000) // readFileSync will throw EACCES
    try {
      resetFixtureCache()
      expect(await fixtureProvider.getNews(['AAPL'])).toEqual([])
    } finally {
      fs.chmodSync(path, originalMode)
      fs.writeFileSync(path, original, 'utf8')
      resetFixtureCache()
    }
  })
})

describe('synthetic history anchors', () => {
  it('falls back to the $100 default when the quote price is unusable', async () => {
    const guard = backupAndRestore([{ name: 'chart-KO-daily.json', mode: 'remove' }])
    guard.corrupt()
    try {
      // No recorded daily file for KO and a zero last price in the overrides
      // (applied after the reset — resets drop overrides with the cache):
      // the walk anchors at the built-in default instead of the broken price.
      resetFixtureCache()
      setFixtureOverrides({
        quotes: [{
          symbol: 'KO', last: 0, bid: 0, ask: 0.01, bidSize: 1, askSize: 1,
          prevClose: 0, dayHigh: 0, dayLow: 0, dayVolume: 0, ts: Date.now(),
        }],
      })
      const bars = await fixtureProvider.getDailyHistory('KO')
      expect(bars.length).toBe(390)
      expect(bars.every((b) => b.c > 0)).toBe(true) // anchored at $100, not $0
    } finally {
      guard.restore()
      resetFixtureCache()
    }
  })
})
