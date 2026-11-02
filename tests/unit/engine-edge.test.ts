import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClock, setClockOverride } from '@/lib/clock'
import { createAgent } from '@/lib/engine/accounts'
import * as accountsModule from '@/lib/engine/accounts'
import { OrderError, resetTradingEngine, tradingEngine } from '@/lib/engine/engine'
import { QuoteService, resetQuoteService, quoteService } from '@/lib/market/quotes'
import { fixtureProvider } from '@/lib/provider/fixture'
import { resetNewsWire } from '@/lib/market/news'
import { db, setDb } from '@/lib/db'
import type { PrismaClient } from '@prisma/client'

// Engine edge branches the happy-path suite doesn't reach: validation gaps,
// order-management errors, expiry carry-over, liquidity budget edges,
// maintenance-sweep corners and the loop lifecycle.

const MONDAY_OPEN = Date.parse('2026-01-05T14:30:00Z')
const MONDAY_POST = Date.parse('2026-01-05T22:00:00Z') // 17:00 ET
const TUESDAY_OPEN = Date.parse('2026-01-06T14:30:00Z')

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

beforeEach(async () => {
  resetQuoteService()
  resetTradingEngine()
  resetNewsWire()
  resetClock()
  setClockOverride({ frozen: MONDAY_OPEN })
  tradingEngine().wireMarketFeed()
  await quoteService().injectQuote('AAPL', { last: 250, bid: 249.99, ask: 250.01, prevClose: 248, dayVolume: 5_000_000 })
  await quoteService().injectQuote('KO', { last: 60, bid: 59.99, ask: 60.01, prevClose: 60, dayVolume: 8_000_000 })
  await wipe()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetClock()
  resetQuoteService()
  resetTradingEngine()
  resetNewsWire()
})

describe('placement validation edges', () => {
  it('rejects calls with missing fields and unknown accounts', async () => {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-val-${Date.now()}`)

    await expect(engine.placeOrder(creds.accountId, { side: 'buy', orderType: 'market', qty: 1 } as never)).rejects.toMatchObject({ code: 'unknown_symbol' })
    await expect(engine.placeOrder(creds.accountId, { symbol: 'AAPL', orderType: 'market', qty: 1 } as never)).rejects.toMatchObject({ code: 'invalid_side' })
    await expect(engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', qty: 1 } as never)).rejects.toMatchObject({ code: 'invalid_order_type' })
    await expect(engine.placeOrder('no-such-account', { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 })).rejects.toMatchObject({ code: 'account_not_found' })
  })

  it('rejects orders for listed symbols with no market data yet', async () => {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-noq-${Date.now()}`)
    await expect(
      engine.placeOrder(creds.accountId, { symbol: 'MSFT', side: 'buy', orderType: 'market', qty: 1 }),
    ).rejects.toMatchObject({ code: 'quote_unavailable', status: 503 })
  })

  it('rejects placement when metrics cannot be computed', async () => {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-met-${Date.now()}`)
    const spy = vi.spyOn(accountsModule, 'computeMetrics').mockResolvedValueOnce(null)
    await expect(
      engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 }),
    ).rejects.toMatchObject({ code: 'account_not_found' })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('order management edges', () => {
  it('wiring twice is a no-op and priceOf misses return null', async () => {
    const engine = tradingEngine()
    engine.wireMarketFeed() // second call: early return
    expect(engine.priceOf('MSFT')).toBeNull()
    expect(engine.priceOf('AAPL')).toBe(250)
  })

  it('cannot cancel or fetch unknown or foreign orders', async () => {
    const engine = tradingEngine()
    const mine = await createAgent(`edge-own-${Date.now()}`)
    const other = await createAgent(`edge-oth-${Date.now()}`)
    const order = await engine.placeOrder(other.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 })

    await expect(engine.cancelOrder(mine.accountId, 'nope')).rejects.toMatchObject({ code: 'order_not_found' })
    await expect(engine.cancelOrder(mine.accountId, order.id)).rejects.toMatchObject({ code: 'order_not_found' })
    await expect(engine.getOrder(mine.accountId, 'nope')).rejects.toMatchObject({ code: 'order_not_found' })
    await expect(engine.getOrder(mine.accountId, order.id)).rejects.toMatchObject({ code: 'order_not_found' })
  })

  it('clamps listOrders limits and honors the symbol filter', async () => {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-list-${Date.now()}`)
    await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 })
    await engine.placeOrder(creds.accountId, { symbol: 'KO', side: 'buy', orderType: 'limit', qty: 1, limitPrice: 10 })

    expect((await engine.listOrders(creds.accountId, { limit: 0 })).length).toBe(1) // clamped to 1
    expect((await engine.listOrders(creds.accountId, { limit: 99_999 })).length).toBe(2) // clamped to 200
    expect((await engine.listOrders(creds.accountId, { symbol: 'ko' })).length).toBe(1)
    expect((await engine.listOrders(creds.accountId, { symbol: 'AAPL', status: 'working' })).length).toBe(0)
    expect((await engine.listOrders(creds.accountId, { status: 'filled' })).length).toBe(1)
  })
})

describe('expiry and carry-over', () => {
  it('rolls a day order placed after the close to the next session', async () => {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-roll-${Date.now()}`)
    setClockOverride({ frozen: MONDAY_POST }) // 17:00 ET Monday — post-market
    const order = await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 1, limitPrice: 250 })
    expect(order.expiresAt).not.toBeNull()
    // After Monday's close, the day order dies at the NEXT session's close.
    expect(order.expiresAt!.getTime()).toBeGreaterThan(MONDAY_POST)
  })

  it('kills carried-over day orders on the first tick of a new session', async () => {
    const creds = await createAgent(`edge-carry-${Date.now()}`)
    // Fresh singletons so the order below exists BEFORE the session's first
    // tick (order.createdAt is explicit because Prisma stamps real wall time).
    resetQuoteService()
    resetTradingEngine()
    const engine = tradingEngine()
    engine.wireMarketFeed()
    const day = await db().order.create({
      data: { accountId: creds.accountId, symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 1, limitPrice: 240, tif: 'day', status: 'working', createdAt: new Date(MONDAY_OPEN) },
    })
    // First tick of the session: a same-session day order is kept.
    await quoteService().injectQuote('AAPL', { last: 250, bid: 249.99, ask: 250.01, prevClose: 248, dayVolume: 5_000_000 })
    expect((await engine.getOrder(creds.accountId, day.id)).status).toBe('working')

    // First tick of the NEXT session: carried day orders expire even though
    // the session is open again.
    setClockOverride({ frozen: TUESDAY_OPEN })
    await quoteService().injectQuote('AAPL', { last: 250.5, bid: 250.49, ask: 250.51 })
    expect((await engine.getOrder(creds.accountId, day.id)).status).toBe('expired')
  })
})

describe('fill loop edges', () => {
  it('skips working orders the book cannot see and orders already complete', async () => {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-skip-${Date.now()}`)

    // An order for a symbol with no live quote: processSymbol returns early.
    await db().order.create({
      data: { accountId: creds.accountId, symbol: 'MSFT', side: 'buy', orderType: 'market', qty: 5, tif: 'day', status: 'working' },
    })
    await engine.onQuote('MSFT')
    expect(await db().fill.count({ where: { symbol: 'MSFT' } })).toBe(0)

    // A fully-filled order still marked working is skipped, while a fresh
    // one behind it still fills.
    await db().order.create({
      data: { accountId: creds.accountId, symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 5, filledQty: 5, tif: 'day', status: 'working' },
    })
    await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 })
    const stale = await db().order.findFirst({ where: { symbol: 'AAPL', filledQty: 5 } })
    expect(stale?.status).toBe('working')
  })

  it('shares the per-tick liquidity budget across orders in FIFO order', async () => {
    const engine = tradingEngine()
    const a = await createAgent(`edge-cap-a-${Date.now()}`, { startingCash: 1_000_000 })
    const b = await createAgent(`edge-cap-b-${Date.now()}`, { startingCash: 1_000_000 })

    // One share of per-tick capacity: 390-day-volume quote → 1 share/min est.
    await quoteService().injectQuote('AAPL', { last: 250, bid: 249.99, ask: 250.01, prevClose: 248, dayVolume: 390 })
    await db().order.create({
      data: { accountId: a.accountId, symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 5, tif: 'day', status: 'working' },
    })
    await db().order.create({
      data: { accountId: b.accountId, symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 5, tif: 'day', status: 'working' },
    })

    await engine.onQuote('AAPL')
    expect(await db().fill.count({ where: { accountId: a.accountId } })).toBe(1) // first in queue took the share
    expect(await db().fill.count({ where: { accountId: b.accountId } })).toBe(0) // budget exhausted
  })

  it('logs and skips fills for accounts that vanished mid-flight', async () => {
    const engine = tradingEngine()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await db().order.create({
      data: { accountId: (await createAgent(`edge-gone-${Date.now()}`)).accountId, symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 5, tif: 'day', status: 'working' },
    })
    // Simulate the account vanishing after the order exists: a proxy client
    // that reports no account for the fill (deleting the real row would
    // cascade the order away, and Prisma delegates cannot be spied).
    const real = db()
    const accountProxy = new Proxy(real.account, {
      get(target, prop, receiver) {
        if (prop === 'findUnique') return async () => null
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const shell = new Proxy(real, {
      get(target, prop, receiver) {
        return prop === 'account' ? accountProxy : Reflect.get(target, prop, receiver)
      },
    })
    setDb(shell as unknown as PrismaClient)
    try {
      await engine.onQuote('AAPL')
      expect(await db().fill.count()).toBe(0)
      expect(errSpy).toHaveBeenCalled()
    } finally {
      setDb(real)
      errSpy.mockRestore()
    }
  })

  it('keeps the average price on a partial close and books realized P&L', async () => {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-part-${Date.now()}`, { startingCash: 100_000 })
    await engine.placeOrder(creds.accountId, { symbol: 'KO', side: 'buy', orderType: 'market', qty: 10 })
    const opened = await db().position.findUnique({ where: { accountId_symbol: { accountId: creds.accountId, symbol: 'KO' } } })
    const avg = opened!.avgPrice

    await quoteService().injectQuote('KO', { last: 62, bid: 61.99, ask: 62.01 })
    await engine.placeOrder(creds.accountId, { symbol: 'KO', side: 'sell', orderType: 'market', qty: 4 })

    const after = await db().position.findUnique({ where: { accountId_symbol: { accountId: creds.accountId, symbol: 'KO' } } })
    expect(after?.qty).toBe(6)
    expect(after?.avgPrice).toBe(avg) // partial close keeps the opening average
    expect(after!.realizedPnl).toBeGreaterThan(0) // sold above entry
  })
})

describe('closing through zero', () => {
  it('re-anchors the average price when a close flips the position sign', async () => {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-flip-${Date.now()}`, { startingCash: 100_000 })
    await engine.placeOrder(creds.accountId, { symbol: 'KO', side: 'buy', orderType: 'market', qty: 10 })

    await quoteService().injectQuote('KO', { last: 70, bid: 69.99, ask: 70.01 })
    await engine.placeOrder(creds.accountId, { symbol: 'KO', side: 'sell', orderType: 'market', qty: 15 })

    const flipped = await db().position.findUnique({ where: { accountId_symbol: { accountId: creds.accountId, symbol: 'KO' } } })
    expect(flipped!.qty).toBe(-5) // long 10, sold 15 -> short 5
    expect(flipped!.avgPrice).toBeGreaterThan(69.9) // re-anchored to the sell fill price
    const fills = await db().fill.findMany({ where: { accountId: creds.accountId, symbol: 'KO' }, orderBy: { ts: 'asc' } })
    expect(flipped!.avgPrice).toBeCloseTo(fills[1].price, 2)
  })
})

describe('pattern day trader carry-over', () => {
  it('still allows a closing sell on a later session (no opening fill today)', async () => {
    // Anchored in June 2027 so real-time fill stamps (Prisma now()) can never
    // count as "today" — the window is driven by dayTrade rows instead.
    const MON = Date.parse('2027-06-07T14:30:00Z') // Monday June 7 2027
    const TUE = Date.parse('2027-06-08T14:30:00Z') // Tuesday June 8 2027
    const engine = tradingEngine()
    const creds = await createAgent(`edge-pdt-${Date.now()}`, { startingCash: 10_000 })
    setClockOverride({ frozen: MON })
    // Three day trades inside the rolling window (rows carry frozen stamps).
    for (let i = 0; i < 3; i++) {
      await db().dayTrade.create({ data: { accountId: creds.accountId, symbol: 'AAPL', ts: new Date(MON) } })
    }
    await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 })

    const metrics = await engine.metrics(creds.accountId)
    expect(metrics!.dayTradeCount).toBe(3)

    // Next session: the closing sell is no longer a same-day round trip.
    setClockOverride({ frozen: TUE })
    const sell = await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'sell', orderType: 'market', qty: 1 })
    expect(sell.status).toBe('filled')
  })
})

describe('maintenance sweep edges', () => {
  async function makeBreachedShort(): Promise<{ accountId: string }> {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-liq-${Date.now()}`, { startingCash: 100_000 })
    await engine.placeOrder(creds.accountId, { symbol: 'KO', side: 'sell', orderType: 'market', qty: 1000 })
    await quoteService().injectQuote('KO', { last: 130, bid: 129.99, ask: 130.01, prevClose: 60 })
    return creds
  }

  it('skips liquidation entirely when there is no AAPL market data to price with', async () => {
    const engine = tradingEngine()
    await makeBreachedShort() // KO short marked at 130 — a real breach
    // Keep the KO quote (the breach lives there) but drop every other quote:
    // the sweep refuses to liquidate without its AAPL reference price.
    resetQuoteService()
    await quoteService().injectQuote('KO', { last: 130, bid: 129.99, ask: 130.01, prevClose: 60 })
    expect(await engine.maintenanceSweep()).toBe(0)
    expect(await db().activity.count({ where: { kind: 'margin_call' } })).toBe(0)
  })

  it('liquidates around an unquoted position and sells longs to restore margin', async () => {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-mix-${Date.now()}`, { startingCash: 500_000 })
    // The quoted AAPL long is bought while the account is healthy; the large
    // unquoted short (marks at avgPrice) then breaches maintenance. The sweep
    // cannot price MSFT, so it works around it by selling the AAPL long.
    await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 50 })
    await db().position.create({ data: { accountId: creds.accountId, symbol: 'MSFT', qty: -3000, avgPrice: 420 } })

    await engine.maintenanceSweep()

    expect(await db().activity.count({ where: { accountId: creds.accountId, kind: 'margin_call' } })).toBe(1)
    expect(await db().activity.count({ where: { accountId: creds.accountId, kind: 'forced_liquidation', symbol: 'AAPL' } })).toBeGreaterThan(0)
    const aapl = await db().position.findUnique({ where: { accountId_symbol: { accountId: creds.accountId, symbol: 'AAPL' } } })
    expect(aapl === null || aapl.qty < 50) // long reduced (possibly to zero)
  })

  it('stops liquidating once maintenance is restored mid-loop', async () => {
    const engine = tradingEngine()
    const creds = await createAgent(`edge-stop-${Date.now()}`, { startingCash: 100_000 })
    // Two short positions; spiking AAPL breaches maintenance. Buying AAPL
    // back restores the account before the small KO short is touched, so the
    // sweep must break out of the position loop with KO intact.
    await engine.placeOrder(creds.accountId, { symbol: 'KO', side: 'sell', orderType: 'market', qty: 10 })
    await engine.placeOrder(creds.accountId, { symbol: 'AAPL', side: 'sell', orderType: 'market', qty: 200 })
    await quoteService().injectQuote('AAPL', { last: 700, bid: 699.99, ask: 700.01, prevClose: 250 })

    const before = await engine.metrics(creds.accountId)
    expect(before!.maintenanceExcess).toBeLessThan(0)

    await engine.maintenanceSweep()

    expect(await db().activity.count({ where: { accountId: creds.accountId, kind: 'margin_call' } })).toBe(1)
    expect(await db().activity.count({ where: { accountId: creds.accountId, kind: 'forced_liquidation', symbol: 'AAPL' } })).toBeGreaterThan(0)
    expect(await db().activity.count({ where: { accountId: creds.accountId, kind: 'forced_liquidation', symbol: 'KO' } })).toBe(0)
    const after = await engine.metrics(creds.accountId)
    expect(after!.maintenanceExcess).toBeGreaterThanOrEqual(0)
  })

  it('tolerates metrics disappearing mid-liquidation', async () => {
    const engine = tradingEngine()
    const creds = await makeBreachedShort()
    const breached = await engine.metrics(creds.accountId)
    expect(breached!.maintenanceExcess).toBeLessThan(0)
    // First call (sweep loop) reports the breach; every later call (post-fill
    // re-check) finds nothing — the sweep must treat that as "restored".
    const spy = vi.spyOn(accountsModule, 'computeMetrics')
      .mockResolvedValueOnce(breached!)
      .mockResolvedValue(null)
    await engine.maintenanceSweep()
    expect(await db().activity.count({ where: { accountId: creds.accountId, kind: 'forced_liquidation' } })).toBeGreaterThan(0)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('snapshot and lifecycle', () => {
  it('skips snapshots for missing accounts', async () => {
    const engine = tradingEngine()
    await engine.snapshotAccount('nope')
    expect(await db().equitySnapshot.count()).toBe(0)
  })

  it('runs the background loops and stops them cleanly', async () => {
    vi.useFakeTimers()
    const engine = tradingEngine()
    // A closed session keeps the quote-tick path sweep-free, so the ONLY
    // sweep invocations come from the interval callbacks.
    setClockOverride({ frozen: Date.parse('2026-01-03T18:00:00Z') })
    const errSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    engine.startLoops()
    // The quote/news services start their own timers; the engine's three
    // intervals fire on the fake clock.
    await vi.advanceTimersByTimeAsync(20_000) // maintenance sweep
    await vi.advanceTimersByTimeAsync(10_000) // settlement + snapshot sweeps
    await vi.advanceTimersByTimeAsync(5 * 60_000) // dividend sweep
    engine.stopLoops()
    engine.stopLoops() // idempotent
    vi.useRealTimers()

    // The sweeps all ran without throwing (they log on failure only).
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('logs sweep failures from the loop callbacks', async () => {
    vi.useFakeTimers()
    const engine = tradingEngine()
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A closed session keeps the quote-tick path sweep-free (same trick as
    // above) and the stretched poll cadence keeps the boot poll quiet, so
    // the interval callbacks own every sweep failure deterministically.
    setClockOverride({ frozen: Date.parse('2026-01-03T18:00:00Z') })
    process.env.MERIDIAN_POLL_INTERVAL_MS = '3_600_000'
    const maintenanceSpy = vi.spyOn(engine, 'maintenanceSweep')
      .mockRejectedValueOnce(new Error('sweep blew up'))
      .mockRejectedValueOnce('string failure')
    const settlementSpy = vi.spyOn(engine, 'settlementSweep')
      .mockRejectedValueOnce('string failure')
      .mockRejectedValueOnce(new Error('settlement blew up'))
    engine.startLoops()

    await vi.advanceTimersByTimeAsync(40_000) // maintenance interval: 20s + 40s
    await vi.advanceTimersByTimeAsync(25_000) // settlement interval: 30s + 60s
    const lines = logSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('maintenance sweep failed') && l.includes('sweep blew up'))).toBe(true)
    expect(lines.some((l) => l.includes('maintenance sweep failed') && l.includes('string failure'))).toBe(true)
    expect(lines.some((l) => l.includes('settlement sweep failed') && l.includes('string failure'))).toBe(true)
    expect(lines.some((l) => l.includes('settlement sweep failed') && l.includes('settlement blew up'))).toBe(true)

    engine.stopLoops()
    vi.useRealTimers()
    maintenanceSpy.mockRestore()
    settlementSpy.mockRestore()
    process.env.MERIDIAN_POLL_INTERVAL_MS = '5000'
  })
})

describe('quote service edges', () => {
  it('reports nulls for unknown symbols and serializes concurrent polls', async () => {
    const qs = quoteService()
    expect(qs.getMinuteBars('NOPE')).toEqual([])
    expect(qs.minuteVolume('NOPE')).toBe(0)

    const first = qs.pollOnce()
    expect(await qs.pollOnce()).toBe(0) // busy → 0
    await first
  })

  it('counts changed quotes and keeps minute-bar state across polls', async () => {
    const qs = quoteService()
    const first = await qs.pollOnce()
    expect(first).toBeGreaterThan(0) // every quote is new
    const second = await qs.pollOnce()
    expect(second).toBe(0) // identical fixture quotes → nothing changed
    expect(qs.getQuote('AAPL')).not.toBeNull()
  })

  it('isolates throwing tick listeners on injected quotes', async () => {
    const qs = quoteService()
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    qs.onTick(() => {
      throw new Error('listener down')
    })
    await qs.injectQuote('AAPL', { last: 251 })
    qs.onTick(() => {
      throw 'string too'
    })
    await qs.injectQuote('AAPL', { last: 252 })
    // The poll path has its own listener guard — same treatment there.
    await qs.pollOnce()
    const lines = logSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('listener down'))).toBe(true)
    expect(lines.some((l) => l.includes('string too'))).toBe(true)
    logSpy.mockRestore()
  })

  it('records poll failures from the provider', async () => {
    const qs = quoteService()
    const spy = vi.spyOn(fixtureProvider, 'getQuotes')
      .mockRejectedValueOnce(new Error('feed down'))
      .mockRejectedValueOnce('raw failure')
    expect(await qs.pollOnce()).toBe(0)
    expect(qs.lastPollError).toBe('feed down')
    expect(await qs.pollOnce()).toBe(0)
    expect(qs.lastPollError).toBe('raw failure')

    spy.mockRestore()
    expect(await qs.pollOnce()).toBeGreaterThan(0)
    expect(qs.lastPollError).toBeNull()
  })

  it('broadcasts nothing when the provider returns an empty batch', async () => {
    const qs = new QuoteService() // no injected state → snapshot early-returns
    vi.spyOn(fixtureProvider, 'getQuotes').mockResolvedValueOnce([])
    expect(await qs.pollOnce()).toBe(0)
    expect(qs.quoteCount()).toBe(0)
  })

  it('uses fresh minute bars for capacity and falls back when they go stale', async () => {
    const qs = new QuoteService() // empty states → symbols() covers the universe
    // Freeze the platform clock at the real wall time so just-fetched bars
    // count as fresh.
    setClockOverride({ frozen: Date.now() })
    await qs.pollOnce()
    // Round-robin minute refresh covers the whole universe in 7 batches of 8.
    for (let i = 0; i < 7; i++) await qs.refreshMinuteBarsBatch()
    const bars = qs.getMinuteBars('AAPL')
    expect(bars.length).toBeGreaterThan(0)
    const total = bars.reduce((sum, b) => sum + b.v, 0)
    expect(qs.minuteVolume('AAPL')).toBe(Math.max(bars[bars.length - 1].v, Math.floor(total / bars.length)))
    // A symbol whose minute series has not been refreshed falls back to the
    // session-average estimate.
    expect(qs.minuteVolume('XOM')).toBe(Math.max(1, Math.floor(qs.getQuote('XOM')!.dayVolume / 390)))

    // Freeze the platform clock a year out: the stored minute bars are now
    // ancient, so minuteVolume falls back to the day-volume estimate.
    setClockOverride({ frozen: Date.now() + 365 * 86_400_000 })
    expect(qs.minuteVolume('AAPL')).toBe(Math.max(1, Math.floor(qs.getQuote('AAPL')!.dayVolume / 390)))
  })

  it('swallows minute-bar refresh failures', async () => {
    const qs = new QuoteService()
    process.env.MERIDIAN_LOG_LEVEL = 'debug' // the failure path logs at debug
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const spy = vi.spyOn(fixtureProvider, 'getMinuteBars')
      .mockRejectedValueOnce(new Error('bars down'))
      .mockRejectedValueOnce('raw bars failure')
    await qs.refreshMinuteBarsBatch()
    const lines = logSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.filter((l) => l.includes('minute bar refresh failed')).length).toBe(2)
    logSpy.mockRestore()
    spy.mockRestore()
    process.env.MERIDIAN_LOG_LEVEL = 'warn'
  })

  it('start() is idempotent until stopped', async () => {
    const qs = quoteService()
    qs.start()
    const before = qs.pollCount
    qs.start() // timer already set — no double polling
    await new Promise((r) => setTimeout(r, 20))
    expect(qs.pollCount).toBeGreaterThanOrEqual(before)
    qs.stop()
    qs.stop()
  })
})

describe('quote poll failure unwind', () => {
  it('releases the busy flag even when the failure path itself explodes', async () => {
    const qs = new QuoteService()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console down')
    })
    const feedSpy = vi.spyOn(fixtureProvider, 'getQuotes').mockRejectedValue(new Error('feed down'))
    await expect(qs.pollOnce()).rejects.toThrow('console down')
    expect(qs.busyHealth()).toBe(false)

    warnSpy.mockRestore()
    feedSpy.mockRestore()
    expect(await qs.pollOnce()).toBeGreaterThan(0) // not stuck busy
  })
})

describe('quote poll latch failure', () => {
  it('propagates a jammed busy latch through the release path', async () => {
    const qs = new QuoteService()
    const jammed = new Proxy(qs, {
      set(target, prop, value, receiver) {
        if (prop === 'busy' && value === false) throw new Error('latch jammed')
        return Reflect.set(target, prop, value, receiver)
      },
    })
    await expect(jammed.pollOnce()).rejects.toThrow('latch jammed')

    // And on the failure path, where the catch's `return 0` loses to the
    // release throw. (The first jam left the latch stuck — release it.)
    Reflect.set(qs, 'busy', false)
    vi.spyOn(fixtureProvider, 'getQuotes').mockRejectedValue(new Error('feed down'))
    await expect(jammed.pollOnce()).rejects.toThrow('latch jammed')
  })
})
