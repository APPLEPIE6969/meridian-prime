import { describe, expect, it } from 'vitest'
import { synthBook, estimatedMinuteVolume } from '@/lib/provider/synth'

describe('book synthesis', () => {
  it('quotes a two-sided market around the last price', () => {
    const book = synthBook(270.0, 1)
    expect(book.bid).toBeLessThan(270)
    expect(book.ask).toBeGreaterThan(270)
    expect(book.ask - book.bid).toBeGreaterThanOrEqual(0.01)
    expect(book.bidSize).toBeGreaterThan(0)
    expect(book.askSize).toBeGreaterThan(0)
  })

  it('never quotes a spread wider than the model spread', () => {
    for (const last of [5, 12.34, 47.5, 123.45, 270.0, 999.99, 1500]) {
      const book = synthBook(last, 7)
      const raw = Math.max(0.01, round2c((last * 1) / 10000))
      expect(book.ask - book.bid, `last=${last}`).toBeLessThanOrEqual(raw + 1e-9)
      expect(book.bid, `last=${last}`).toBeGreaterThan(0)
    }
  })

  it('holds the one-cent floor on cheap names', () => {
    const book = synthBook(2.5, 3)
    expect(book.ask - book.bid).toBeGreaterThanOrEqual(0.01 - 1e-9)
    const penny = synthBook(0.55, 3)
    expect(penny.ask - penny.bid).toBeGreaterThanOrEqual(0.01 - 1e-9)
  })

  it('is deterministic per seed', () => {
    const a = synthBook(100, 42)
    const b = synthBook(100, 42)
    expect(a).toEqual(b)
  })
})

describe('volume estimation', () => {
  it('estimates per-minute volume from the session length', () => {
    expect(estimatedMinuteVolume(3_900_000)).toBe(10_000)
    expect(estimatedMinuteVolume(0)).toBe(1)
  })
})

function round2c(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
