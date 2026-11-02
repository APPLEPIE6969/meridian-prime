import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CandleCache, candleCache, resetCandleCache } from '@/lib/market/candles'
import { fixtureProvider } from '@/lib/provider/fixture'
import type { Candle } from '@/lib/provider/types'

// CandleCache: TTL behavior, in-flight dedupe (concurrent callers share one
// provider pull) and the reset seams.

const bars: Candle[] = [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }]

beforeEach(() => {
  resetCandleCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('candle cache', () => {
  it('deduplicates concurrent loads for the same key', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const spy = vi.spyOn(fixtureProvider, 'getDailyHistory').mockReturnValue(gate.then(() => bars))

    const cache = new CandleCache()
    const first = cache.dailyHistory('AAPL', '1y')
    const second = cache.dailyHistory('AAPL', '1y') // same key, in flight
    release()
    expect(await second).toBe(bars)
    expect(await first).toBe(bars)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('serves cached series and refreshes per TTL class', async () => {
    const dailySpy = vi.spyOn(fixtureProvider, 'getDailyHistory').mockResolvedValue(bars)
    const minuteSpy = vi.spyOn(fixtureProvider, 'getMinuteBars').mockResolvedValue(bars)

    const cache = new CandleCache()
    expect(await cache.dailyHistory('MSFT', '1y')).toBe(bars)
    expect(await cache.dailyHistory('MSFT', '1y')).toBe(bars) // cached
    expect(dailySpy).toHaveBeenCalledTimes(1)

    expect(await cache.intraday('AAPL', '1d', '1m')).toBe(bars)
    expect(await cache.intraday('AAPL', '1d', '1m')).toBe(bars) // cached
    expect(minuteSpy).toHaveBeenCalledTimes(1)
  })

  it('reset() and resetCandleCache() clear every layer', async () => {
    const dailySpy = vi.spyOn(fixtureProvider, 'getDailyHistory').mockResolvedValue(bars)
    const cache = candleCache()
    await cache.dailyHistory('NVDA', '5y')
    cache.reset()
    await cache.dailyHistory('NVDA', '5y') // reloaded after reset
    expect(dailySpy).toHaveBeenCalledTimes(2)

    await candleCache().dailyHistory('NVDA', '5y') // still cached from the reload
    resetCandleCache()
    await candleCache().dailyHistory('NVDA', '5y') // fresh singleton reloads
    expect(dailySpy).toHaveBeenCalledTimes(3)
  })
})
