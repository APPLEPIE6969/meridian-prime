import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { resetClock, setClockOverride } from '@/lib/clock'
import { createAgent } from '@/lib/engine/accounts'
import { OrderError, resetTradingEngine, tradingEngine } from '@/lib/engine/engine'
import { quoteService, resetQuoteService } from '@/lib/market/quotes'
import { db } from '@/lib/db'

// The whole engine suite runs on a frozen regular session:
// Monday 2026-01-05, 09:30 ET (right at the open).
const OPEN = Date.parse('2026-01-05T14:30:00Z')
const POST_MARKET = Date.parse('2026-01-05T22:00:00Z') // 17:00 ET
const TUESDAY_LATE = Date.parse('2026-01-06T23:00:00Z') // past T+1 settle (18:00 ET)

async function wipe(): Promise<void> {
  await db().fill.deleteMany()
  await db().order.deleteMany()
  await db().position.deleteMany()
  await db().cashLedger.deleteMany()
  await db().equitySnapshot.deleteMany()
  await db().dayTrade.deleteMany()
  await db().activity.deleteMany()
  await db().account.deleteMany()
}

async function boot(): Promise<ReturnType<typeof tradingEngine>> {
  resetQuoteService()
  resetTradingEngine()
  resetClock()
  setClockOverride({ frozen: OPEN })
  const engine = tradingEngine()
  engine.wireMarketFeed()
  await quoteService().injectQuote('AAPL', { last: 250, bid: 249.99, ask: 250.01, prevClose: 248, dayVolume: 5_000_000 })
  await quoteService().injectQuote('KO', { last: 60, bid: 59.99, ask: 60.01, prevClose: 60, dayVolume: 8_000_000 })
  return engine
}

beforeEach(async () => {
  await wipe()
})

afterEach(() => {
  resetClock()
  resetQuoteService()
  resetTradingEngine()
})

describe('market orders', () => {
  it('fill immediately at the ask plus impact with full accounting', async () => {
    const engine = await boot()
    const creds = await createAgent(`mkt-${Date.now()}`, { startingCash: 100_000 })
    const order = await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 10 })

    expect(order.status).toBe('filled')
    expect(order.filledQty).toBe(10)
    expect(order.avgFillPrice).toBeGreaterThan(250.01) // paid the offer + impact

    const position = await db().position.findUnique({ where: { accountId_symbol: { accountId: creds.accountId, symbol: 'AAPL' } } })
    expect(position?.qty).toBe(10)

    const trade = await db().cashLedger.findFirst({ where: { accountId: creds.accountId, kind: 'trade' } })
    expect(trade?.amount).toBe(-Math.round(10 * order.avgFillPrice! * 100) / 100)
    expect(trade?.settled).toBe(false)

    const fill = await db().fill.findFirst({ where: { accountId: creds.accountId } })
    expect(fill?.fees).toBe(0) // no fees on buys

    const activity = await db().activity.findFirst({ where: { accountId: creds.accountId, kind: 'fill' } })
    expect(activity?.message).toContain('Filled')
  })

  it('partial-fill against the tick capacity and continue on later ticks', async () => {
    const engine = await boot()
    const creds = await createAgent(`part-${Date.now()}`, { startingCash: 5_000_000 })
    // capacity = 5% of 5,000,000/390 ≈ 641 shares per tick
    const order = await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 5000 })
    expect(order.status).toBe('partially_filled')
    expect(order.filledQty).toBeGreaterThan(0)
    expect(order.filledQty).toBeLessThan(5000)

    // Next tick keeps grinding the remainder
    await quoteService().injectQuote('AAPL', { last: 250.5, ask: 250.52, bid: 250.48 })
    const after = await engine.getOrder(creds.accountId, order.id)
    expect(after.filledQty).toBeGreaterThan(order.filledQty)
  })

  it('rejects market orders outside regular hours', async () => {
    await boot()
    setClockOverride({ frozen: Date.parse('2026-01-03T18:00:00Z') }) // Saturday
    const creds = await createAgent(`closed-${Date.now()}`)
    await expect(
      tradingEngine().placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 10 }),
    ).rejects.toMatchObject({ code: 'market_closed', status: 422 })
  })
})

describe('limit orders', () => {
  it('fill immediately when marketable, with price improvement', async () => {
    const engine = await boot()
    const creds = await createAgent(`lim-${Date.now()}`, { startingCash: 100_000 })
    const order = await engine.placeOrder(creds.accountId, {
      symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 10, limitPrice: 251,
    })
    expect(order.status).toBe('filled')
    expect(order.avgFillPrice!).toBeLessThanOrEqual(251)
    expect(order.avgFillPrice!).toBeGreaterThanOrEqual(250.01)
  })

  it('rest at the book until the quote reaches them', async () => {
    const engine = await boot()
    const creds = await createAgent(`rest-${Date.now()}`, { startingCash: 100_000 })
    const order = await engine.placeOrder(creds.accountId, {
      symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 10, limitPrice: 245,
    })
    expect(order.status).toBe('working')

    await quoteService().injectQuote('AAPL', { last: 244.9, bid: 244.89, ask: 244.91 })
    const after = await engine.getOrder(creds.accountId, order.id)
    expect(after.status).toBe('filled')
    expect(after.avgFillPrice!).toBeLessThanOrEqual(245)
  })

  it('can be canceled while working', async () => {
    const engine = await boot()
    const creds = await createAgent(`cx-${Date.now()}`, { startingCash: 100_000 })
    const order = await engine.placeOrder(creds.accountId, {
      symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 10, limitPrice: 240, tif: 'gtc',
    })
    const canceled = await engine.cancelOrder(creds.accountId, order.id)
    expect(canceled.status).toBe('canceled')
    await expect(engine.cancelOrder(creds.accountId, order.id)).rejects.toMatchObject({ code: 'not_cancellable' })
  })

  it('queue while the market is closed (limit, not market)', async () => {
    await boot()
    setClockOverride({ frozen: Date.parse('2026-01-03T18:00:00Z') })
    const creds = await createAgent(`q-${Date.now()}`)
    const engine = tradingEngine()
    const order = await engine.placeOrder(creds.accountId, {
      symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 10, limitPrice: 250, tif: 'gtc',
    })
    expect(order.status).toBe('working')
    expect(order.filledQty).toBe(0)
  })

  it('expire at the close if still working; GTC survives', async () => {
    const engine = await boot()
    const creds = await createAgent(`exp-${Date.now()}`, { startingCash: 100_000 })
    const day = await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 5, limitPrice: 240 })
    const gtc = await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 5, limitPrice: 240, tif: 'gtc' })

    setClockOverride({ frozen: POST_MARKET })
    await quoteService().injectQuote('AAPL', { last: 250 }) // tick drives the expiry sweep

    expect((await engine.getOrder(creds.accountId, day.id)).status).toBe('expired')
    expect((await engine.getOrder(creds.accountId, gtc.id)).status).toBe('working')
  })
})

describe('validation', () => {
  it('rejects unknown symbols, bad quantities and bad parameters', async () => {
    const engine = await boot()
    const creds = await createAgent(`val-${Date.now()}`)
    await expect(engine.placeOrder(creds.accountId, { symbol: 'ZZZZ', side: 'buy', orderType: 'market', qty: 1 })).rejects.toMatchObject({ code: 'unknown_symbol' })
    await expect(engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 0 })).rejects.toMatchObject({ code: 'invalid_qty' })
    await expect(engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 10.5 })).rejects.toMatchObject({ code: 'invalid_qty' })
    await expect(engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'hold', orderType: 'market', qty: 1 })).rejects.toMatchObject({ code: 'invalid_side' })
    await expect(engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'stop', qty: 1 })).rejects.toMatchObject({ code: 'invalid_order_type' })
    await expect(engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 1, limitPrice: 0 })).rejects.toMatchObject({ code: 'invalid_limit_price' })
    await expect(engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1, tif: 'ioc' })).rejects.toMatchObject({ code: 'invalid_tif' })
  })

  it('enforces buying power on both account types', async () => {
    const engine = await boot()
    const cash = await createAgent(`bp-cash-${Date.now()}`, { startingCash: 10_000, kind: 'cash' })
    await expect(
      engine.placeOrder(cash.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 100, limitPrice: 250 }),
    ).rejects.toMatchObject({ code: 'insufficient_buying_power' })

    const margin = await createAgent(`bp-margin-${Date.now()}`, { startingCash: 100_000 })
    await expect(
      engine.placeOrder(margin.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 1000, limitPrice: 250 }),
    ).rejects.toMatchObject({ code: 'insufficient_buying_power' })
  })

  it('blocks shorting in cash accounts', async () => {
    const engine = await boot()
    const creds = await createAgent(`short-${Date.now()}`, { startingCash: 50_000, kind: 'cash' })
    await expect(
      engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'sell', orderType: 'market', qty: 10 }),
    ).rejects.toMatchObject({ code: 'shorting_requires_margin' })
  })
})

describe('shorting', () => {
  it('opens a short and covers it with realized P&L', async () => {
    const engine = await boot()
    const creds = await createAgent(`cover-${Date.now()}`, { startingCash: 500_000 })
    const open = await engine.placeOrder(creds.accountId, { symbol: 'KO', side: 'sell', orderType: 'market', qty: 100 })
    expect(open.status).toBe('filled')
    let position = await db().position.findUnique({ where: { accountId_symbol: { accountId: creds.accountId, symbol: 'KO' } } })
    expect(position?.qty).toBe(-100)

    await quoteService().injectQuote('KO', { last: 55, bid: 54.99, ask: 55.01 })
    const cover = await engine.placeOrder(creds.accountId, { symbol: 'KO', side: 'buy', orderType: 'market', qty: 100 })
    expect(cover.status).toBe('filled')
    position = await db().position.findUnique({ where: { accountId_symbol: { accountId: creds.accountId, symbol: 'KO' } } })
    expect(position).toBeNull() // closed flat and removed

    const metrics = await engine.metrics(creds.accountId)
    expect(metrics!.equity).toBeGreaterThan(0)
    const realized = (cover.avgFillPrice! - open.avgFillPrice!) * -100
    expect(realized).toBeGreaterThan(0) // sold 60, covered 55
  })
})

describe('pattern day trader rule', () => {
  it('blocks the fourth day trade in five business days on a small account', async () => {
    const engine = await boot()
    const creds = await createAgent(`pdt-${Date.now()}`, { startingCash: 10_000 })

    for (let i = 0; i < 3; i++) {
      await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 5 })
      await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'sell', orderType: 'market', qty: 5 })
    }
    const metrics = await engine.metrics(creds.accountId)
    expect(metrics!.dayTradeCount).toBe(3)

    // The next opening buy is fine, but its closing sell is blocked.
    await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 5 })
    await expect(
      engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'sell', orderType: 'market', qty: 5 }),
    ).rejects.toMatchObject({ code: 'pdt_restricted' })
  })
})

describe('settlement', () => {
  it('settles trade cash T+1', async () => {
    const engine = await boot()
    const creds = await createAgent(`stl-${Date.now()}`, { startingCash: 100_000 })
    await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 10 })

    let unsettled = await db().cashLedger.findFirst({ where: { accountId: creds.accountId, settled: false } })
    expect(unsettled).not.toBeNull()

    expect(await engine.settlementSweep()).toBe(0) // settle date is tomorrow

    setClockOverride({ frozen: TUESDAY_LATE }) // Tuesday 18:00 ET — past T+1
    expect(await engine.settlementSweep()).toBeGreaterThan(0)

    unsettled = await db().cashLedger.findFirst({ where: { accountId: creds.accountId, settled: false } })
    expect(unsettled).toBeNull()
  })
})

describe('margin calls', () => {
  it('force-liquidates shorts that breach maintenance', async () => {
    const engine = await boot()
    const creds = await createAgent(`liq-${Date.now()}`, { startingCash: 100_000 })
    await engine.placeOrder(creds.accountId, { symbol: 'KO', side: 'sell', orderType: 'market', qty: 1000 })

    // Short 1000 @ ~60 leaves 160k cash vs a 130k short mark: equity 30k
    // against a 30% short requirement of 39k -> breach.
    await quoteService().injectQuote('KO', { last: 130, bid: 129.99, ask: 130.01, prevClose: 60 })

    await engine.maintenanceSweep()

    const call = await db().activity.findFirst({ where: { accountId: creds.accountId, kind: 'margin_call' } })
    expect(call).not.toBeNull()
    const forced = await db().activity.findFirst({ where: { accountId: creds.accountId, kind: 'forced_liquidation' } })
    expect(forced).not.toBeNull()

    const metrics = await engine.metrics(creds.accountId)
    expect(metrics!.maintenanceExcess).toBeGreaterThanOrEqual(0)
    const position = await db().position.findUnique({ where: { accountId_symbol: { accountId: creds.accountId, symbol: 'KO' } } })
    expect(Math.abs(position?.qty ?? 0)).toBeLessThan(1000)
  })
})

describe('equity snapshots', () => {
  it('record the account over time', async () => {
    const engine = await boot()
    const creds = await createAgent(`snap-${Date.now()}`, { startingCash: 100_000 })
    await engine.snapshotSweep()
    const rows = await db().equitySnapshot.findMany({ where: { accountId: creds.accountId } })
    expect(rows.length).toBe(1)
    expect(rows[0].equity).toBe(100_000)
  })
})

describe('error plumbing', () => {
  it('carries structured codes on OrderError', () => {
    const err = new OrderError('nope', 'not today', 409)
    expect(err.code).toBe('nope')
    expect(err.status).toBe(409)
    expect(err.message).toBe('not today')
  })
})
