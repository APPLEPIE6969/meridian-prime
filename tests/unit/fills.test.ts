import { describe, expect, it } from 'vitest'
import { fillCapacity, impactPrice, limitPlan, marketPlan } from '@/lib/engine/fills'
import type { Quote } from '@/lib/provider/types'

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: 'TEST',
    last: 100,
    bid: 99.99,
    ask: 100.01,
    bidSize: 500,
    askSize: 500,
    prevClose: 100,
    dayHigh: 101,
    dayLow: 99,
    dayVolume: 3_900_000, // 10k/min estimated
    ts: Date.now(),
    ...overrides,
  }
}

describe('fill capacity', () => {
  it('applies the participation rate to per-minute volume', () => {
    expect(fillCapacity(10_000, 3_900_000)).toBe(500) // 5% of 10k
  })

  it('falls back to a day-volume estimate without fresh minute bars', () => {
    expect(fillCapacity(0, 3_900_000)).toBe(500)
    expect(fillCapacity(0, 0)).toBe(1)
  })
})

describe('market order fills', () => {
  it('buys take liquidity from the ask plus impact', () => {
    const plan = marketPlan('buy', 100, quote(), 10_000)
    expect(plan.filledQty).toBe(100)
    expect(plan.remaining).toBe(0)
    expect(plan.fills[0].price).toBeGreaterThan(100.01) // crossed above the touch
    expect(plan.fills[0].price).toBeLessThan(101)
  })

  it('sells hit the bid minus impact', () => {
    const plan = marketPlan('sell', 100, quote(), 10_000)
    expect(plan.fills[0].price).toBeLessThan(99.99)
    expect(plan.fills[0].price).toBeGreaterThan(99)
  })

  it('partials when the order exceeds the tick capacity', () => {
    const plan = marketPlan('buy', 5000, quote(), 500) // tick budget: 500 shares
    expect(plan.filledQty).toBe(500)
    expect(plan.remaining).toBe(4500)
  })

  it('impact scales with notional vs ADV', () => {
    const small = marketPlan('buy', 10, quote(), 1_000_000).fills[0].price
    const large = marketPlan('buy', 200_000, quote(), 1_000_000).fills[0].price
    expect(large).toBeGreaterThan(small)
  })
})

describe('limit order fills', () => {
  it('fills marketable limits with price improvement inside the limit', () => {
    const q = quote()
    const plan = limitPlan('buy', 100, 100.50, q, 10_000)
    expect(plan.filledQty).toBe(100)
    expect(plan.fills[0].price).toBeLessThanOrEqual(100.50)
    expect(plan.fills[0].price).toBeGreaterThanOrEqual(q.ask)
  })

  it('leaves unmarketable limits working', () => {
    const plan = limitPlan('buy', 100, 99.50, quote(), 10_000)
    expect(plan.filledQty).toBe(0)
    expect(plan.reason).toBe('not_marketable')
    expect(plan.remaining).toBe(100)
  })

  it('respects limit prices on the sell side', () => {
    const plan = limitPlan('sell', 100, 99.90, quote(), 10_000)
    expect(plan.filledQty).toBe(100)
    expect(plan.fills[0].price).toBeGreaterThanOrEqual(99.90)
    const unmarketable = limitPlan('sell', 100, 100.50, quote(), 10_000)
    expect(unmarketable.reason).toBe('not_marketable')
  })
})

describe('impact model', () => {
  it('is adverse on both sides and grows sub-linearly with size', () => {
    const buySmall = impactPrice(100, 5_000, 50_000_000, 'buy')
    const buyLarge = impactPrice(100, 500_000, 50_000_000, 'buy')
    const sellSmall = impactPrice(100, 5_000, 50_000_000, 'sell')
    expect(buySmall).toBeGreaterThan(100)
    expect(buyLarge).toBeGreaterThan(buySmall)
    expect(sellSmall).toBeLessThan(100)
  })

  it('never reverses the sign for tiny orders', () => {
    const px = impactPrice(100, 1, 100_000_000, 'buy')
    expect(px).toBeCloseTo(100, 2)
  })
})

// ── no-liquidity guards (100% coverage pass) ─────────────────────────────────

describe('no-liquidity guards', () => {
  it('returns an empty plan for market orders with zero capacity', () => {
    const plan = marketPlan('buy', 100, quote(), 0)
    expect(plan.fills).toEqual([])
    expect(plan.filledQty).toBe(0)
    expect(plan.remaining).toBe(100)
    expect(plan.reason).toBe('no_liquidity')
  })

  it('clamps negative capacity to zero for market orders', () => {
    const plan = marketPlan('sell', 100, quote(), -50)
    expect(plan.reason).toBe('no_liquidity')
  })

  it('returns an empty plan for marketable limits with zero capacity', () => {
    const plan = limitPlan('buy', 100, 100.50, quote(), 0)
    expect(plan.fills).toEqual([])
    expect(plan.reason).toBe('no_liquidity')
  })

  it('clamps negative capacity to zero for limit orders', () => {
    const plan = limitPlan('sell', 100, 99.90, quote(), -1)
    expect(plan.reason).toBe('no_liquidity')
  })
})
