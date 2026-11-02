import { describe, expect, it } from 'vitest'
import { addMoney, notional, round2, round4, roundUp2, signedQty, subMoney } from '@/lib/money'
import { computeFees } from '@/lib/engine/fees'

describe('money rounding', () => {
  it('rounds to cents without float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(1.005)).toBe(1.01)
    expect(round2(2.675)).toBe(2.68)
  })

  it('rounds prices to 4 decimals', () => {
    expect(round4(1 / 3)).toBe(0.3333)
    expect(round4(100.12345)).toBe(100.1235)
  })

  it('rounds regulatory fees UP to the cent', () => {
    expect(roundUp2(10.001)).toBe(10.01)
    expect(roundUp2(10.000)).toBe(10)
    expect(roundUp2(0.001)).toBe(0.01)
  })

  it('keeps ledger chains cent-exact', () => {
    let balance = 1_000_000
    for (let i = 0; i < 1000; i++) {
      balance = addMoney(balance, -333.33)
      balance = addMoney(balance, 333.33)
    }
    expect(balance).toBe(1_000_000)
  })

  it('computes notionals and signed quantities', () => {
    expect(notional(100, 12.345)).toBe(1234.5)
    expect(signedQty('buy', 10)).toBe(10)
    expect(signedQty('sell', 10)).toBe(-10)
    expect(subMoney(1, 0.999)).toBe(0)
  })
})

describe('fee schedule', () => {
  it('charges buys nothing beyond commission', () => {
    const fees = computeFees('buy', 100, 50)
    expect(fees).toEqual({ commission: 0, sec: 0, taf: 0, total: 0 })
  })

  it('charges SEC + TAF on sells, rounded up to the cent', () => {
    const fees = computeFees('sell', 100, 50) // $5,000 proceeds
    // SEC: 5000 * 27.8 / 1e6 = 0.139 -> 0.14
    expect(fees.sec).toBe(0.14)
    // TAF: 100 * 0.000166 = 0.0166 -> 0.02
    expect(fees.taf).toBe(0.02)
    expect(fees.total).toBe(0.16)
  })

  it('caps the trading activity fee at $8.30', () => {
    const fees = computeFees('sell', 1_000_000, 10)
    expect(fees.taf).toBe(8.3)
  })

  it('never rounds the SEC fee down', () => {
    const fees = computeFees('sell', 1, 1) // $1 proceeds -> 0.0000278 -> 0.01
    expect(fees.sec).toBe(0.01)
    expect(fees.total).toBe(0.02) // + TAF 0.01
  })
})

// ── formatting helpers (100% coverage pass) ──────────────────────────────────

import { fmtPct, fmtUsd, isBuySide } from '@/lib/money'

describe('formatting helpers', () => {
  it('classifies order sides', () => {
    expect(isBuySide('buy')).toBe(true)
    expect(isBuySide('sell')).toBe(false)
    expect(isBuySide('')).toBe(false)
  })

  it('formats dollars with grouping', () => {
    expect(fmtUsd(1234.5)).toBe('$1,234.50')
    expect(fmtUsd(-0.01)).toBe('-$0.01')
  })

  it('signs percentages only on the positive side', () => {
    expect(fmtPct(0.125)).toBe('+12.50%')
    expect(fmtPct(-0.03)).toBe('-3.00%')
    expect(fmtPct(0)).toBe('+0.00%')
  })
})
