// Live Robinhood quotes adapter — the independent failover hop.
//
// Public keyless endpoints (no API key, no auth):
//   /quotes/?symbols=A,B,C       — real-time top of book: last, bid/ask + sizes
//   /fundamentals/?symbols=A,B,C — today's high/low/volume, order-matched
//
// Quotes-only by design: bars, dividends and news stay Yahoo-only, and the
// failover chain simply serves empty series for them while this source is
// active. `results` arrays align with the requested symbol order; the
// fundamentals call is best-effort — if it fails or drifts, quotes still
// flow with synthesized day bounds and zero volume.

import { round2 } from '../money'
import { synthBook } from './synth'
import { fetchJsonWithRetry } from './http'
import type { MarketDataProvider, Quote } from './types'

const BASE = 'https://api.robinhood.com'

export interface RhQuoteRow {
  symbol?: string
  trading_halted?: boolean
  last_trade_price?: string | null
  last_extended_hours_trade_price?: string | null
  bid_price?: string | null
  ask_price?: string | null
  bid_size?: number | null
  ask_size?: number | null
  previous_close?: string | null
  updated_at?: string | null
}

export interface RhFundamentalRow {
  open?: string | null
  high?: string | null
  low?: string | null
  volume?: string | null
}

function num(v: string | number | null | undefined): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/** Map one Robinhood quote row (+ optional fundamentals row) to a Quote. */
export function parseRhQuote(row: RhQuoteRow, fund: RhFundamentalRow | undefined): Quote | null {
  const symbol = row.symbol?.toUpperCase()
  if (!symbol || row.trading_halted) return null
  const regular = num(row.last_trade_price)
  const extended = num(row.last_extended_hours_trade_price)
  const last = Number.isFinite(regular) && regular > 0 ? regular : extended
  if (!Number.isFinite(last) || last <= 0) return null
  const prevCloseRaw = num(row.previous_close)
  const prevClose = Number.isFinite(prevCloseRaw) && prevCloseRaw > 0 ? round2(prevCloseRaw) : round2(last)

  // Real top of book when the venue prints one; synthesized around the last
  // otherwise (pre-open, after hours, halted auction prints).
  const bid = num(row.bid_price)
  const ask = num(row.ask_price)
  const book =
    bid > 0 && ask > bid
      ? {
          bid: round2(bid),
          ask: round2(ask),
          bidSize: Math.max(1, Math.floor(row.bid_size ?? 100)),
          askSize: Math.max(1, Math.floor(row.ask_size ?? 100)),
        }
      : synthBook(round2(last), Math.floor(Date.now() / 60_000) + symbol.length)

  const high = num(fund?.high)
  const low = num(fund?.low)
  const volume = num(fund?.volume)
  const ts = row.updated_at ? Date.parse(row.updated_at) : NaN
  return {
    symbol,
    last: round2(last),
    bid: book.bid,
    ask: book.ask,
    bidSize: book.bidSize,
    askSize: book.askSize,
    prevClose,
    dayHigh: Number.isFinite(high) && high > 0 ? round2(high) : round2(Math.max(last, prevClose)),
    dayLow: Number.isFinite(low) && low > 0 ? round2(low) : round2(Math.min(last, prevClose)),
    dayVolume: Number.isFinite(volume) && volume >= 0 ? Math.floor(volume) : 0,
    ts: Number.isFinite(ts) ? ts : Date.now(),
  }
}

export const robinhoodProvider: MarketDataProvider = {
  name: 'robinhood',

  async getQuote(symbol) {
    const rows = await this.getQuotes([symbol])
    return rows[0] ?? null
  },

  async getQuotes(symbols) {
    const caps = symbols.map((s) => s.toUpperCase())
    if (caps.length === 0) return []
    const list = caps.map(encodeURIComponent).join(',')
    const [quotes, funds] = await Promise.all([
      fetchJsonWithRetry<{ results?: Array<RhQuoteRow | null> }>(`${BASE}/quotes/?symbols=${list}`),
      // Best-effort day hydration; a failure here degrades to synthesized
      // bounds and zero volume instead of taking the feed down.
      fetchJsonWithRetry<{ results?: Array<RhFundamentalRow | null> }>(`${BASE}/fundamentals/?symbols=${list}`).catch(
        () => null,
      ),
    ])
    const rows = quotes.results ?? []
    const fundRows = funds?.results ?? []
    // Fundamentals only map when they align 1:1 with the request order.
    const aligned = fundRows.length === caps.length ? fundRows : []
    return rows
      .map((row, i) => (row ? parseRhQuote(row, aligned[i] ?? undefined) : null))
      .filter((q): q is Quote => q !== null)
  },

  async getMinuteBars() {
    return []
  },

  async getDailyHistory() {
    return []
  },

  async getDividends() {
    return []
  },

  async getNews() {
    return []
  },
}
