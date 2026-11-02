// QuoteService — the desk's live market feed.
//
// One instance per process (pinned on globalThis: in the standalone build
// the instrumentation graph and the route graph are separate module
// instances, and both must observe the same feed state). Each poll cycle:
//   1. batched quote fetch for the whole universe
//   2. round-robin 1-minute series refresh (execution capacity input)
//   3. tick listeners (the trading engine) notified per symbol

import { now } from '../clock'
import { cfg } from '../config'
import { log } from '../log'
import { relayPush } from '../relay'
import { activeProvider } from '../provider'
import { estimatedMinuteVolume } from '../provider/synth'
import { SYMBOLS } from '../universe'
import type { Candle, Quote } from '../provider/types'

export interface SymbolState {
  quote: Quote
  minuteBars: Candle[]
  minuteTs: number
}

export type TickListener = (symbol: string, quote: Quote) => void | Promise<void>

const MINUTE_BARS_MAX_AGE_MS = 120_000

export class QuoteService {
  private states = new Map<string, SymbolState>()
  private listeners: TickListener[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private minuteCursor = 0
  private busy = false
  lastPollAt = 0
  lastPollError: string | null = null
  pollCount = 0

  onTick(listener: TickListener): void {
    this.listeners.push(listener)
  }

  getQuote(symbol: string): Quote | null {
    return this.states.get(symbol.toUpperCase())?.quote ?? null
  }

  getMinuteBars(symbol: string): Candle[] {
    return this.states.get(symbol.toUpperCase())?.minuteBars ?? []
  }

  /** Per-minute traded volume used by the fill engine to cap capacity. */
  minuteVolume(symbol: string): number {
    const state = this.states.get(symbol.toUpperCase())
    if (!state) return 0
    const bars = state.minuteBars
    if (bars.length > 0 && now().getTime() - state.minuteTs < MINUTE_BARS_MAX_AGE_MS) {
      // The newest bar may be a partial minute (real-time data has the same
      // artifact) — never let it understate liquidity below the session
      // average for this symbol.
      const last = bars[bars.length - 1].v
      let total = 0
      for (const bar of bars) total += bar.v
      return Math.max(last, Math.floor(total / bars.length))
    }
    return estimatedMinuteVolume(state.quote.dayVolume)
  }

  /** Test/ops seam: inject or overwrite a quote and notify listeners. */
  async injectQuote(symbol: string, patch: Partial<Quote>): Promise<Quote> {
    const sym = symbol.toUpperCase()
    const existing = this.states.get(sym)?.quote
    const base: Quote = existing ?? {
      symbol: sym,
      last: 100,
      bid: 99.99,
      ask: 100.01,
      bidSize: 500,
      askSize: 500,
      prevClose: 100,
      dayHigh: 101,
      dayLow: 99,
      dayVolume: 5_000_000,
      ts: Date.now(),
    }
    const merged: Quote = {
      ...base,
      ...patch,
      symbol: sym,
      last: patch.last ?? base.last,
    }
    if (patch.bid === undefined) merged.bid = Math.max(0.01, round2c(merged.last - 0.01))
    if (patch.ask === undefined) merged.ask = round2c(merged.last + 0.01)
    if (patch.dayVolume === undefined && !existing) merged.dayVolume = base.dayVolume
    this.states.set(sym, {
      quote: merged,
      minuteBars: this.states.get(sym)?.minuteBars ?? [],
      minuteTs: this.states.get(sym)?.minuteTs ?? 0,
    })
    for (const listener of this.listeners) {
      try {
        await listener(sym, merged)
      } catch (err) {
        log('warn', 'tick listener failed', { symbol: sym, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return merged
  }

  symbols(): string[] {
    return this.states.size > 0 ? [...this.states.keys()] : [...SYMBOLS]
  }

  quoteCount(): number {
    return this.states.size
  }

  async pollOnce(): Promise<number> {
    if (this.busy) return 0
    this.busy = true
    try {
      const provider = activeProvider()
      const quotes = await provider.getQuotes(this.symbols())
      let changed = 0
      for (const quote of quotes) {
        const prev = this.states.get(quote.symbol)?.quote
        this.states.set(quote.symbol, {
          quote,
          minuteBars: this.states.get(quote.symbol)?.minuteBars ?? [],
          minuteTs: this.states.get(quote.symbol)?.minuteTs ?? 0,
        })
        if (!prev || prev.last !== quote.last) changed++
        for (const listener of this.listeners) {
          try {
            await listener(quote.symbol, quote)
          } catch (err) {
            log('warn', 'tick listener failed', {
              symbol: quote.symbol,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
      this.lastPollAt = Date.now()
      this.pollCount++
      this.lastPollError = null
      await this.refreshMinuteBarsBatch()
      this.broadcastSnapshot()
      return changed
    } catch (err) {
      this.lastPollError = err instanceof Error ? err.message : String(err)
      log('warn', 'quote poll failed', { error: this.lastPollError })
      return 0
    } finally {
      this.busy = false
    }
  }

  private broadcastSnapshot(): void {
    if (this.states.size === 0) return
    const quotes = [...this.states.values()].map((s) => ({
      symbol: s.quote.symbol,
      last: s.quote.last,
      bid: s.quote.bid,
      ask: s.quote.ask,
      prevClose: s.quote.prevClose,
      dayVolume: s.quote.dayVolume,
    }))
    relayPush('market', { quotes, at: new Date().toISOString() })
  }

  async refreshMinuteBarsBatch(): Promise<void> {
    const batch = Math.max(1, cfg().minuteRefresh)
    const symbols = this.symbols()
    if (symbols.length === 0) return
    const picks: string[] = []
    for (let i = 0; i < Math.min(batch, symbols.length); i++) {
      picks.push(symbols[this.minuteCursor % symbols.length])
      this.minuteCursor++
    }
    const provider = activeProvider()
    await Promise.all(
      picks.map(async (symbol) => {
        try {
          const bars = await provider.getMinuteBars(symbol)
          const state = this.states.get(symbol)
          if (state) {
            state.minuteBars = bars
            state.minuteTs = Date.now()
          }
        } catch (err) {
          log('debug', 'minute bar refresh failed', {
            symbol,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }),
    )
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.pollOnce()
    }, cfg().pollIntervalMs)
    this.timer.unref?.()
    void this.pollOnce()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

function round2c(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

const g = globalThis as unknown as { __meridianQuotes?: QuoteService }

export function quoteService(): QuoteService {
  if (!g.__meridianQuotes) g.__meridianQuotes = new QuoteService()
  return g.__meridianQuotes
}

export function resetQuoteService(): void {
  g.__meridianQuotes?.stop()
  g.__meridianQuotes = undefined
}
