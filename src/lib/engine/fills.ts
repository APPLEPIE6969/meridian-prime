// Fill decision engine — where execution realism lives.
//
// Orders do NOT print at the last price. Every fill:
//   - takes liquidity from the synthesized book (buy at ask, sell at bid),
//   - is capped by a participation limit on the symbol's traded volume
//     (the caller owns the per-tick liquidity budget and shares it across
//     every working order in that symbol),
//   - pays square-root market impact scaled by order notional vs ADV,
//   - and limit orders keep price improvement inside the limit.

import { IMPACT_COEFF, MIN_ADV_NOTIONAL, PARTICIPATION_RATE } from '../config'
import { round4 } from '../money'
import type { Quote } from '../provider/types'

export interface PlannedFill {
  qty: number
  price: number
}

export interface FillPlan {
  fills: PlannedFill[]
  filledQty: number
  remaining: number
  reason?: 'no_liquidity' | 'not_marketable'
}

/** Execution capacity for one poll cycle: a share of per-minute volume. */
export function fillCapacity(minuteVolume: number, dayVolume: number): number {
  const perMinute = minuteVolume > 0 ? minuteVolume : Math.max(1, Math.floor(dayVolume / 390))
  return Math.max(1, Math.floor(perMinute * PARTICIPATION_RATE))
}

/** Square-root impact applied adversely to the touch. */
export function impactPrice(
  refPrice: number,
  fillNotional: number,
  advNotional: number,
  side: string,
): number {
  const frac = IMPACT_COEFF * Math.sqrt(fillNotional / Math.max(advNotional, MIN_ADV_NOTIONAL))
  const px = side === 'buy' ? refPrice * (1 + frac) : refPrice * (1 - frac)
  return round4(px)
}

export function marketPlan(side: string, qty: number, quote: Quote, capacity: number): FillPlan {
  const take = Math.min(qty, Math.max(0, capacity))
  if (take < 1) {
    return { fills: [], filledQty: 0, remaining: qty, reason: 'no_liquidity' }
  }
  const touch = side === 'buy' ? quote.ask : quote.bid
  const advNotional = Math.max(1, quote.dayVolume * quote.prevClose)
  const price = impactPrice(touch, take * touch, advNotional, side)
  return { fills: [{ qty: take, price }], filledQty: take, remaining: qty - take }
}

export function limitPlan(
  side: string,
  qty: number,
  limitPrice: number,
  quote: Quote,
  capacity: number,
): FillPlan {
  const touch = side === 'buy' ? quote.ask : quote.bid
  const marketable = side === 'buy' ? touch <= limitPrice + 1e-9 : touch >= limitPrice - 1e-9
  if (!marketable) {
    return { fills: [], filledQty: 0, remaining: qty, reason: 'not_marketable' }
  }
  const take = Math.min(qty, Math.max(0, capacity))
  if (take < 1) {
    return { fills: [], filledQty: 0, remaining: qty, reason: 'no_liquidity' }
  }
  const advNotional = Math.max(1, quote.dayVolume * quote.prevClose)
  const impacted = impactPrice(touch, take * touch, advNotional, side)
  const price = side === 'buy' ? Math.min(limitPrice, impacted) : Math.max(limitPrice, impacted)
  return { fills: [{ qty: take, price: round4(price) }], filledQty: take, remaining: qty - take }
}
