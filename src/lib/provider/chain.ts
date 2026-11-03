// Live data failover chain.
//
// The desk must always serve the REAL tape, so instead of falling back to
// recorded fixtures when Yahoo has a bad day, the chain walks independent
// keyless live sources until one answers:
//
//   1. yahoo          — query1.finance.yahoo.com (primary, full capability)
//   2. yahoo-mirror   — query2.finance.yahoo.com (same API, separate edge)
//   3. robinhood      — api.robinhood.com (independent venue, quotes only)
//
// Every call starts at the healthiest head of the chain: a source that just
// failed enters a cooldown and is skipped (and probed again once it expires,
// which is the automatic fail-back). Only if every source fails does the
// error surface to the poll loop, which keeps serving the last known book.
// Health is pinned on globalThis for the same bundle-split reason as the
// quote service singleton.

import { cfg } from '../config'
import { log } from '../log'
import { robinhoodProvider } from './robinhood'
import { yahooMirrorProvider, yahooProvider } from './yahoo'
import type { MarketDataProvider } from './types'

export interface SourceHealth {
  name: string
  failures: number
  lastError: string | null
  lastSuccessAt: number | null
  cooldownUntil: number
}

interface ChainState {
  health: Map<string, SourceHealth>
  active: string | null
}

const CHAIN: MarketDataProvider[] = [yahooProvider, yahooMirrorProvider, robinhoodProvider]

const g = globalThis as unknown as { __meridianChain?: ChainState }

function state(): ChainState {
  if (!g.__meridianChain) g.__meridianChain = { health: new Map(), active: null }
  return g.__meridianChain
}

function healthOf(name: string): SourceHealth {
  const map = state().health
  let h = map.get(name)
  if (!h) {
    h = { name, failures: 0, lastError: null, lastSuccessAt: null, cooldownUntil: 0 }
    map.set(name, h)
  }
  return h
}

/** Operator/test seam: forget all chain health (full-fidelity probing). */
export function resetChainHealth(): void {
  g.__meridianChain = undefined
}

/** Chain health for the operator console: active source + per-source state. */
export function dataHealth(): { active: string | null; sources: SourceHealth[] } {
  return {
    active: state().active,
    sources: CHAIN.map((p) => ({ ...healthOf(p.name) })),
  }
}

/** Run `op` against the first healthy source; walk the chain on failure. */
async function firstHealthy<T>(what: string, op: (provider: MarketDataProvider) => Promise<T>): Promise<T> {
  const cooldownMs = cfg().failoverCooldownMs
  let lastError: unknown = new Error('no live data source answered')
  for (const provider of CHAIN) {
    const h = healthOf(provider.name)
    if (h.cooldownUntil > Date.now()) continue
    try {
      const out = await op(provider)
      h.failures = 0
      h.lastError = null
      h.lastSuccessAt = Date.now()
      state().active = provider.name
      return out
    } catch (err) {
      h.failures++
      // The fetch layers always reject with Error instances; String() keeps
      // this display normalization branch-free for anything exotic.
      h.lastError = String(err).replace(/^Error: /, '')
      h.cooldownUntil = Date.now() + cooldownMs
      log('warn', 'market data source failed, walking the chain', {
        source: provider.name,
        operation: what,
        error: h.lastError,
      })
      lastError = err
    }
  }
  throw lastError
}

export const chainedProvider: MarketDataProvider = {
  name: 'live-chain',

  getQuote(symbol: string) {
    return firstHealthy('getQuote', (p) => p.getQuote(symbol))
  },

  getQuotes(symbols: string[]) {
    return firstHealthy('getQuotes', (p) => p.getQuotes(symbols))
  },

  getMinuteBars(symbol: string) {
    return firstHealthy('getMinuteBars', (p) => p.getMinuteBars(symbol))
  },

  getDailyHistory(symbol: string, range?: string) {
    return firstHealthy('getDailyHistory', (p) => p.getDailyHistory(symbol, range))
  },

  getDividends(symbol: string, range?: string) {
    return firstHealthy('getDividends', (p) => p.getDividends(symbol, range))
  },

  getNews(symbols: string[], limit?: number) {
    return firstHealthy('getNews', (p) => p.getNews(symbols, limit))
  },
}
