import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setClockOverride, resetClock } from '@/lib/clock'
import { DividendService, dividendService, resetDividendService } from '@/lib/engine/dividends'
import { createAgent } from '@/lib/engine/accounts'
import { tradingEngine, resetTradingEngine } from '@/lib/engine/engine'
import { quoteService, resetQuoteService } from '@/lib/market/quotes'
import { fixtureProvider } from '@/lib/provider/fixture'
import { db } from '@/lib/db'
import { SYMBOLS } from '@/lib/universe'

// Dividends: long holders receive cash per share, short holders pay it,
// one ledger row per (symbol, ex-date), events outside the 7-day lookback
// window are ignored, and a failing provider never kills the sweep.

const OPEN = Date.parse('2026-01-05T14:30:00Z') // Monday open

async function wipe(): Promise<void> {
  await db().cashLedger.deleteMany()
  await db().activity.deleteMany()
  await db().position.deleteMany()
  await db().order.deleteMany()
  await db().fill.deleteMany()
  await db().account.deleteMany()
}

beforeEach(async () => {
  resetDividendService()
  resetQuoteService()
  resetTradingEngine()
  resetClock()
  setClockOverride({ frozen: OPEN })
  await wipe()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetDividendService()
  resetClock()
  resetQuoteService()
  resetTradingEngine()
})

describe('DividendService', () => {
  it('credits long holders and debits shorts, exactly once per ex-date', async () => {
    const long = await createAgent('div-long', { startingCash: 100_000 })
    const short = await createAgent('div-short', { startingCash: 100_000 })
    await db().position.create({ data: { accountId: long.accountId, symbol: 'AAPL', qty: 10, avgPrice: 250 } })
    await db().position.create({ data: { accountId: short.accountId, symbol: 'AAPL', qty: -4, avgPrice: 250 } })

    const svc = new DividendService()
    const exDate = OPEN - 2 * 86_400_000 // inside the 7-day lookback
    const spy = vi.spyOn(fixtureProvider, 'getDividends').mockResolvedValue([{ exDate, amount: 0.25 }])

    const settled = await svc.sweep(6)
    expect(settled).toBe(2)
    expect(spy).toHaveBeenCalledWith('AAPL', '6mo')

    const longRow = await db().cashLedger.findFirst({ where: { accountId: long.accountId, kind: 'dividend' } })
    expect(longRow?.amount).toBe(2.5) // 10 shares × $0.25
    expect(longRow?.settled).toBe(true)
    const shortRow = await db().cashLedger.findFirst({ where: { accountId: short.accountId, kind: 'dividend' } })
    expect(shortRow?.amount).toBe(-1) // shorts pay

    const longActivity = await db().activity.findFirst({ where: { accountId: long.accountId, kind: 'dividend' } })
    expect(longActivity?.message).toContain('Dividend received')
    const shortActivity = await db().activity.findFirst({ where: { accountId: short.accountId, kind: 'dividend' } })
    expect(shortActivity?.message).toContain('Dividend paid (short)')

    // Idempotent: a second full-universe sweep over the same ex-date finds
    // the ledger refs and settles nothing new.
    expect(await svc.sweep(SYMBOLS.length)).toBe(0)
    expect(await db().cashLedger.count({ where: { kind: 'dividend' } })).toBe(2)
  })

  it('ignores events outside the lookback window and in the future', async () => {
    const spy = vi.spyOn(fixtureProvider, 'getDividends').mockResolvedValue([
      { exDate: OPEN + 86_400_000, amount: 1 }, // future
      { exDate: OPEN - 9 * 86_400_000, amount: 1 }, // too old
    ])
    const svc = new DividendService()
    expect(await svc.sweep(6)).toBe(0)
    expect(spy).toHaveBeenCalled()
    expect(await db().cashLedger.count({ where: { kind: 'dividend' } })).toBe(0)
  })

  it('skips zero-amount events for real holders and flat positions', async () => {
    const holder = await createAgent('div-flat')
    await db().position.create({ data: { accountId: holder.accountId, symbol: 'AAPL', qty: 5, avgPrice: 250 } })
    await db().position.create({ data: { accountId: holder.accountId, symbol: 'KO', qty: 0, avgPrice: 60 } })
    vi.spyOn(fixtureProvider, 'getDividends').mockResolvedValue([{ exDate: OPEN - 86_400_000, amount: 0 }])
    const svc = new DividendService()
    expect(await svc.sweep(6)).toBe(0)
    expect(await db().cashLedger.count({ where: { kind: 'dividend' } })).toBe(0)
  })

  it('records provider failures in lastError and keeps sweeping', async () => {
    vi.spyOn(fixtureProvider, 'getDividends').mockRejectedValue(new Error('provider down'))
    const svc = new DividendService()
    expect(await svc.sweep(6)).toBe(0)
    expect(svc.lastError).toBe('provider down')
    expect(svc.lastSweepAt).toBeGreaterThan(0)
  })

  it('stringifies non-Error provider failures', async () => {
    vi.spyOn(fixtureProvider, 'getDividends').mockRejectedValue('raw string failure')
    const svc = new DividendService()
    await svc.sweep(6)
    expect(svc.lastError).toBe('raw string failure')
  })

  it('clears lastError once a sweep actually settles something', async () => {
    const holder = await createAgent('div-clear', { startingCash: 100_000 })
    await db().position.create({ data: { accountId: holder.accountId, symbol: 'AAPL', qty: 10, avgPrice: 250 } })
    const svc = new DividendService()
    const exDate = OPEN - 86_400_000 // inside the lookback window
    const spy = vi.spyOn(fixtureProvider, 'getDividends')
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue([{ exDate, amount: 0.25 }])
    // One full-universe batch: AAPL's fetch fails, the rest find no positions.
    await svc.sweep(SYMBOLS.length)
    expect(svc.lastError).toBe('transient')
    // The next full pass lands AAPL's settlement and clears the flag.
    await svc.sweep(SYMBOLS.length)
    expect(svc.lastError).toBeNull() // settled > 0 clears the flag
    expect(await db().cashLedger.count({ where: { kind: 'dividend' } })).toBe(1)
  })

  it('rotates the universe cursor across sweeps', async () => {
    const svc = new DividendService()
    const spy = vi.spyOn(fixtureProvider, 'getDividends').mockResolvedValue([])
    await svc.sweep(2)
    const first = spy.mock.calls.map((c) => c[0])
    await svc.sweep(2)
    const all = spy.mock.calls.map((c) => c[0])
    expect(all.slice(first.length)).not.toEqual(first) // moved on to new symbols
  })

  it('serializes concurrent sweeps behind the busy flag', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(fixtureProvider, 'getDividends').mockReturnValue(gate.then(() => []))
    const svc = new DividendService()
    const first = svc.sweep(6)
    expect(await svc.sweep(6)).toBe(0) // busy → immediate zero
    release()
    await first
    expect(svc.lastSweepAt).toBeGreaterThan(0)
  })
})

describe('dividend singleton', () => {
  it('pins one service instance and resets on demand', async () => {
    expect(dividendService()).toBe(dividendService())
    resetDividendService()
    expect(dividendService()).not.toBeNull()
  })

  it('flows through the engine lifecycle', async () => {
    // The engine's dividend timer calls dividendService().sweep(); make sure
    // the singleton the engine sees is the same one tests can reset.
    const svc = dividendService()
    expect(svc).toBeInstanceOf(DividendService)
    tradingEngine()
    quoteService()
    resetTradingEngine()
    resetQuoteService()
  })
})
