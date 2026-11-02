import { MIN_SPREAD, SPREAD_BPS } from '../config'
import { round2 } from '../money'

export interface Book {
  bid: number
  ask: number
  bidSize: number
  askSize: number
}

/**
 * Synthesize a two-sided book around the last traded price.
 *
 * Spread = max(1 cent, SPREAD_BPS of last). Rounding can only ever tighten
 * the raw spread to the 1-cent floor — a post-rounding guard re-centers the
 * book so the quoted spread never exceeds the model spread (rounding both
 * sides outward would fake wider markets than the tape implies).
 */
export function synthBook(last: number, seed: number): Book {
  const raw = Math.max(MIN_SPREAD, round2((last * SPREAD_BPS) / 10000))
  let bid = round2(last - raw / 2)
  let ask = round2(last + raw / 2)
  if (ask - bid > raw + 1e-9) {
    bid = round2(last - raw / 2)
    ask = round2(bid + raw)
  }
  if (ask - bid < MIN_SPREAD - 1e-9) {
    bid = round2(last - MIN_SPREAD / 2)
    ask = round2(bid + MIN_SPREAD)
  }
  // Deterministic pseudo-size from the seed (stable per symbol+minute).
  const h = Math.abs(Math.sin(seed) * 10000) % 1
  const h2 = Math.abs(Math.cos(seed * 1.7) * 10000) % 1
  return {
    bid,
    ask,
    bidSize: 100 + Math.floor(h * 15) * 100,
    askSize: 100 + Math.floor(h2 * 15) * 100,
  }
}

/** Estimated per-minute traded volume used to cap execution capacity. */
export function estimatedMinuteVolume(dayVolume: number): number {
  return Math.max(1, Math.floor(dayVolume / 390))
}
