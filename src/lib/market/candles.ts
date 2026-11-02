// CandleCache — provider history with TTLs sized to how the data moves:
// daily bars for six hours, intraday bars for a minute.

import { activeProvider } from '../provider'
import type { Candle } from '../provider/types'

interface Entry {
  bars: Candle[]
  at: number
}

const DAILY_TTL_MS = 6 * 60 * 60 * 1000
const INTRADAY_TTL_MS = 60 * 1000

export class CandleCache {
  private daily = new Map<string, Entry>()
  private intradayCache = new Map<string, Entry>()
  private inflight = new Map<string, Promise<Candle[]>>()

  async dailyHistory(symbol: string, range = '5y'): Promise<Candle[]> {
    const key = `${symbol}:${range}`
    const hit = this.daily.get(key)
    if (hit && Date.now() - hit.at < DAILY_TTL_MS) return hit.bars
    return this.load(key, async () => {
      const bars = await activeProvider().getDailyHistory(symbol, range)
      this.daily.set(key, { bars, at: Date.now() })
      return bars
    })
  }

  async intraday(symbol: string, range = '1d', interval = '5m'): Promise<Candle[]> {
    const key = `${symbol}:${range}:${interval}`
    const hit = this.intradayCache.get(key)
    if (hit && Date.now() - hit.at < INTRADAY_TTL_MS) return hit.bars
    return this.load(key, async () => {
      // The provider exposes minute bars for the current session; longer
      // intraday windows reuse the same series.
      const bars = await activeProvider().getMinuteBars(symbol)
      this.intradayCache.set(key, { bars, at: Date.now() })
      return bars
    })
  }

  private async load(key: string, fetcher: () => Promise<Candle[]>): Promise<Candle[]> {
    const pending = this.inflight.get(key)
    if (pending) return pending
    const promise = fetcher().finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return promise
  }

  reset(): void {
    this.daily.clear()
    this.intradayCache.clear()
    this.inflight.clear()
  }
}

const g = globalThis as unknown as { __meridianCandles?: CandleCache }

export function candleCache(): CandleCache {
  if (!g.__meridianCandles) g.__meridianCandles = new CandleCache()
  return g.__meridianCandles
}

export function resetCandleCache(): void {
  g.__meridianCandles = undefined
}
