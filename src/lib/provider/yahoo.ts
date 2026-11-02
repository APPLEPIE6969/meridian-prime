// Live Yahoo Finance adapter — the desk's production data source.
//
// Endpoints (no API key):
//   v7 spark   — batch quotes, ≤16 symbols per call, per-symbol URI encoding
//   v8 chart   — candles (1m/1d), quote meta, dividend events
//   RSS feed   — per-symbol headline wire
//
// All parses are pure exported functions so the unit suite can drive them
// against recorded real payloads (tests/fixtures/*) without network access.

import { round2 } from '../money'
import { synthBook } from './synth'
import type { Candle, DividendEvent, MarketDataProvider, NewsHeadline, Quote } from './types'

const BASE = 'https://query1.finance.yahoo.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_BATCH = 16
const TIMEOUT_MS = 12_000

interface ChartResult {
  meta: Record<string, unknown>
  timestamp?: number[]
  indicators?: { quote?: Array<Record<string, Array<number | null>>> }
  events?: { dividends?: Record<string, { amount: number; date: number }> }
}

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, accept: 'application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`upstream ${res.status} for ${url}`)
        await new Promise((r) => setTimeout(r, 800 * (i + 1)))
        continue
      }
      if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`)
      return res
    } catch (err) {
      lastError = err
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetchWithRetry(url)
  return (await res.json()) as T
}

// ── Parsers (pure) ───────────────────────────────────────────────────────────

export function parseChartEnvelope(payload: unknown): ChartResult | null {
  const envelope = payload as { chart?: { result?: ChartResult[]; error?: unknown } }
  const result = envelope?.chart?.result?.[0]
  if (!result) return null
  return result
}

export function candlesFromChart(result: ChartResult): Candle[] {
  const ts = result.timestamp ?? []
  const q = result.indicators?.quote?.[0]
  if (!q) return []
  const bars: Candle[] = []
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i]
    if (c === null || c === undefined) continue
    bars.push({
      t: ts[i] * 1000,
      o: q.open?.[i] ?? c,
      h: q.high?.[i] ?? c,
      l: q.low?.[i] ?? c,
      c,
      v: q.volume?.[i] ?? 0,
    })
  }
  return bars
}

export function dividendsFromChart(result: ChartResult): DividendEvent[] {
  const events = result.events?.dividends ?? {}
  return Object.values(events)
    .map((e) => ({ exDate: e.date * 1000, amount: e.amount }))
    .sort((a, b) => a.exDate - b.exDate)
}

export function quoteFromSparkItem(item: SparkItem): Quote | null {
  const resp = item.response?.[0]
  if (!resp) return null
  const meta = resp.meta ?? {}
  const last = Number(meta.regularMarketPrice)
  const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose)
  if (!Number.isFinite(last) || last <= 0) return null
  const dayVolume = Number(meta.regularMarketVolume ?? 0)
  const seedBase = Math.floor(Date.now() / 60_000) + item.symbol.length
  const book = synthBook(last, seedBase)
  return {
    symbol: item.symbol,
    last: round2(last),
    bid: book.bid,
    ask: book.ask,
    bidSize: book.bidSize,
    askSize: book.askSize,
    prevClose: Number.isFinite(prevClose) ? round2(prevClose) : round2(last),
    dayHigh: Number.isFinite(Number(meta.regularMarketDayHigh)) ? round2(Number(meta.regularMarketDayHigh)) : round2(last),
    dayLow: Number.isFinite(Number(meta.regularMarketDayLow)) ? round2(Number(meta.regularMarketDayLow)) : round2(last),
    dayVolume: Number.isFinite(dayVolume) ? dayVolume : 0,
    ts: Number(meta.regularMarketTime) ? Number(meta.regularMarketTime) * 1000 : Date.now(),
  }
}

export interface SparkItem {
  symbol: string
  response: Array<{ meta: Record<string, unknown> }>
}

export function parseSparkEnvelope(payload: unknown): SparkItem[] {
  const envelope = payload as { spark?: { result?: SparkItem[] } }
  return envelope?.spark?.result ?? []
}

// ── RSS parsing (dependency-free) ────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function tagText(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const m = block.match(re)
  if (!m) return ''
  return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim())
}

export interface RawRssItem {
  providerId: string
  headline: string
  url: string
  summary: string
  publishedAt: Date
}

export function parseRss(xml: string, symbol: string, maxItems = 24): RawRssItem[] {
  const items: RawRssItem[] = []
  const blocks = xml.split(/<item>/i).slice(1)
  for (const block of blocks.slice(0, maxItems)) {
    const body = block.split(/<\/item>/i)[0]
    const title = tagText(body, 'title')
    const link = tagText(body, 'link')
    const guid = tagText(body, 'guid') || link
    if (!title || !link || !guid) continue
    const pub = tagText(body, 'pubDate')
    const parsed = pub ? Date.parse(pub) : NaN
    items.push({
      providerId: guid,
      headline: title,
      url: link,
      summary: tagText(body, 'description').slice(0, 500),
      publishedAt: Number.isFinite(parsed) ? new Date(parsed) : new Date(),
    })
  }
  void symbol
  return items
}

// ── Provider ─────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export const yahooProvider: MarketDataProvider = {
  name: 'yahoo',

  async getQuote(symbol) {
    const rows = await this.getQuotes([symbol])
    return rows[0] ?? null
  },

  async getQuotes(symbols) {
    const batches = chunk(symbols, MAX_BATCH)
    const results = await Promise.all(
      batches.map(async (batch) => {
        const qs = batch.map(encodeURIComponent).join(',')
        const url = `${BASE}/v7/finance/spark?symbols=${qs}&range=1d&interval=5m`
        const payload = await fetchJson<unknown>(url)
        return parseSparkEnvelope(payload)
          .map(quoteFromSparkItem)
          .filter((q): q is Quote => q !== null)
      }),
    )
    return results.flat()
  },

  async getMinuteBars(symbol) {
    const url = `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=false`
    const payload = await fetchJson<unknown>(url)
    const result = parseChartEnvelope(payload)
    return result ? candlesFromChart(result) : []
  },

  async getDailyHistory(symbol, range = '5y') {
    const url = `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`
    const payload = await fetchJson<unknown>(url)
    const result = parseChartEnvelope(payload)
    return result ? candlesFromChart(result) : []
  },

  async getDividends(symbol, range = '6mo') {
    const url = `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d&events=div`
    const payload = await fetchJson<unknown>(url)
    const result = parseChartEnvelope(payload)
    return result ? dividendsFromChart(result) : []
  },

  async getNews(symbols, limit = 12) {
    const capped = symbols.slice(0, 8)
    const feeds = await Promise.all(
      capped.map(async (symbol) => {
        const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`
        const res = await fetchWithRetry(url)
        const xml = await res.text()
        return parseRss(xml, symbol).map((item) => ({ ...item, symbols: [symbol] }))
      }),
    )
    const seen = new Set<string>()
    const merged: NewsHeadline[] = []
    for (const feed of feeds.flat()) {
      if (seen.has(feed.providerId)) continue
      seen.add(feed.providerId)
      merged.push({
        providerId: feed.providerId,
        headline: feed.headline,
        source: 'Yahoo Finance',
        url: feed.url,
        symbols: feed.symbols,
        summary: feed.summary,
        publishedAt: feed.publishedAt,
      })
      if (merged.length >= limit) break
    }
    return merged
  },
}
