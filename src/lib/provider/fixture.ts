// Offline provider backed by recorded real market payloads (tests/fixtures/).
// Used by the unit suites and by `MERIDIAN_DATA_PROVIDER=fixture` boots so
// the desk can be rehearsed deterministically without network access. All
// fixture files were captured from the live Yahoo endpoints — parsing goes
// through the same pure functions the live adapter uses.

import fs from 'node:fs'
import path from 'node:path'
import { repoPath } from '../paths'
import {
  candlesFromChart,
  dividendsFromChart,
  parseChartEnvelope,
  parseRss,
  parseSparkEnvelope,
  quoteFromSparkItem,
  type SparkItem,
} from './yahoo'
import { synthBook } from './synth'
import type { Candle, DividendEvent, MarketDataProvider, NewsHeadline, Quote } from './types'
import { round2 } from '../money'

function readFixture(name: string): unknown | null {
  try {
    const file = repoPath('tests', 'fixtures', name)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function loadSparkQuotes(): Quote[] {
  const quotes: Quote[] = []
  for (const name of ['spark-1.json', 'spark-2.json', 'spark-3.json', 'spark-4.json']) {
    const payload = readFixture(name)
    if (!payload) continue
    for (const item of parseSparkEnvelope(payload)) {
      const q = quoteFromSparkItem(item)
      if (q) quotes.push(q)
    }
  }
  return quotes
}

function loadChartCandles(name: string): Candle[] {
  const payload = readFixture(name)
  if (!payload) return []
  const result = parseChartEnvelope(payload)
  return result ? candlesFromChart(result) : []
}

function loadChartDividends(name: string): DividendEvent[] {
  const payload = readFixture(name)
  if (!payload) return []
  const result = parseChartEnvelope(payload)
  return result ? dividendsFromChart(result) : []
}

function loadRss(name: string): ReturnType<typeof parseRss> {
  try {
    const file = repoPath('tests', 'fixtures', name)
    if (!fs.existsSync(file)) return []
    return parseRss(fs.readFileSync(file, 'utf8'), 'AAPL')
  } catch {
    return []
  }
}

// Deterministic synthetic daily history for symbols without recorded
// fixtures: seeded random walk ending at the fixture quote's last price.
function syntheticHistory(symbol: string, endPrice: number): Candle[] {
  let seed = 0
  for (const ch of symbol) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
  const bars: Candle[] = []
  const n = 390
  const day = 86_400_000
  const end = endPrice > 0 ? endPrice : 100
  let price = end
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const r = (seed / 0xffffffff - 0.5) * 0.03
    const o = round2(price)
    const c = round2(price * (1 + r))
    const h = round2(Math.max(o, c) * 1.004)
    const l = round2(Math.min(o, c) * 0.996)
    const t = Date.now() - (n - i) * day
    bars.push({ t, o, h, l, c, v: 2_000_000 + (seed % 3_000_000) })
    price = c
  }
  return bars
}

interface FixtureCache {
  quotes: Quote[]
  aaplIntraday: Candle[]
  daily: Map<string, Candle[]>
  dividends: Map<string, DividendEvent[]>
  news: NewsHeadline[]
}

let cache: FixtureCache | null = null

function fixtures(): FixtureCache {
  if (cache) return cache
  const quotes = loadSparkQuotes()
  const daily = new Map<string, Candle[]>([
    ['AAPL', loadChartCandles('chart-AAPL-daily.json')],
    ['MSFT', loadChartCandles('chart-MSFT-daily.json')],
    ['NVDA', loadChartCandles('chart-NVDA-daily.json')],
  ])
  for (const [symbol, bars] of daily) {
    if (bars.length === 0) {
      const q = quotes.find((x) => x.symbol === symbol)
      daily.set(symbol, syntheticHistory(symbol, q?.last ?? 100))
    }
  }
  cache = {
    quotes,
    aaplIntraday: loadChartCandles('chart-AAPL-intraday.json'),
    daily,
    dividends: new Map([['AAPL', loadChartDividends('chart-AAPL-dividends.json')]]),
    news: loadRss('news-AAPL.xml').map((item) => ({
      providerId: item.providerId,
      headline: item.headline,
      source: 'Yahoo Finance',
      url: item.url,
      symbols: ['AAPL'],
      summary: item.summary,
      publishedAt: item.publishedAt,
    })),
  }
  return cache
}

/** Test seam: drop in replacement quote/candle maps. */
export function setFixtureOverrides(overrides: Partial<Pick<FixtureCache, 'quotes' | 'aaplIntraday'>>): void {
  const f = fixtures()
  if (overrides.quotes) f.quotes = overrides.quotes
  if (overrides.aaplIntraday) f.aaplIntraday = overrides.aaplIntraday
}

export function resetFixtureCache(): void {
  cache = null
}

export const fixtureProvider: MarketDataProvider = {
  name: 'fixture',

  async getQuote(symbol) {
    const f = fixtures()
    return f.quotes.find((q) => q.symbol === symbol.toUpperCase()) ?? null
  },

  async getQuotes(symbols) {
    const f = fixtures()
    const wanted = new Set(symbols.map((s) => s.toUpperCase()))
    return f.quotes.filter((q) => wanted.has(q.symbol))
  },

  async getMinuteBars(symbol) {
    const f = fixtures()
    return symbol.toUpperCase() === 'AAPL' ? f.aaplIntraday : []
  },

  async getDailyHistory(symbol) {
    const f = fixtures()
    const sym = symbol.toUpperCase()
    const real = f.daily.get(sym)
    if (real) return real
    const q = f.quotes.find((x) => x.symbol === sym)
    return syntheticHistory(sym, q?.last ?? 100)
  },

  async getDividends(symbol) {
    const f = fixtures()
    return f.dividends.get(symbol.toUpperCase()) ?? []
  },

  async getNews(symbols, limit = 12) {
    const f = fixtures()
    const wanted = new Set(symbols.map((s) => s.toUpperCase()))
    const rows = f.news.filter((n) => n.symbols.some((s) => wanted.has(s)))
    return rows.slice(0, limit)
  },
}
