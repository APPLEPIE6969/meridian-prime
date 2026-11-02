// DividendService — real corporate actions flow to real holders.
//
// Ex-dividend events come from the provider (historical + recent window).
// On each sweep the service rotates through the universe, looks for events
// whose ex-date falls inside a 7-day lookback, and settles them once —
// long holders receive cash per share, short holders pay it. Idempotency:
// one ledger row per (symbol, ex-date) via the ref field.

import { now } from '../clock'
import { db } from '../db'
import { log } from '../log'
import { activeProvider } from '../provider'
import { round2 } from '../money'
import { SYMBOLS } from '../universe'

const LOOKBACK_MS = 7 * 86_400_000

export class DividendService {
  private cursor = 0
  private busy = false
  lastSweepAt = 0
  lastError: string | null = null

  async sweep(batchSize = 6): Promise<number> {
    if (this.busy) return 0
    this.busy = true
    try {
      const batch: string[] = []
      for (let i = 0; i < Math.min(batchSize, SYMBOLS.length); i++) {
        batch.push(SYMBOLS[this.cursor % SYMBOLS.length])
        this.cursor++
      }
      let settled = 0
      const horizon = now().getTime()
      for (const symbol of batch) {
        try {
          const events = await activeProvider().getDividends(symbol, '6mo')
          for (const event of events) {
            if (event.exDate > horizon || event.exDate <= horizon - LOOKBACK_MS) continue
            settled += await this.settleEvent(symbol, event.exDate, event.amount)
          }
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err)
          log('debug', 'dividend fetch failed', { symbol, error: this.lastError })
        }
      }
      this.lastSweepAt = Date.now()
      this.lastError = settled === 0 && this.lastError ? this.lastError : null
      return settled
    } finally {
      this.busy = false
    }
  }

  private async settleEvent(symbol: string, exDateMs: number, amountPerShare: number): Promise<number> {
    const dateKey = new Date(exDateMs).toISOString().slice(0, 10)
    const ref = `${symbol}:${dateKey}`
    const existing = await db().cashLedger.findFirst({ where: { kind: 'dividend', ref } })
    if (existing) return 0
    const positions = await db().position.findMany({ where: { symbol, NOT: { qty: 0 } } })
    let settled = 0
    for (const position of positions) {
      const gross = round2(Math.abs(position.qty) * amountPerShare)
      if (gross <= 0) continue
      const amount = position.qty > 0 ? gross : -gross
      await db().cashLedger.create({
        data: { accountId: position.accountId, kind: 'dividend', amount, settled: true, ref },
      })
      await db().activity.create({
        data: {
          accountId: position.accountId,
          kind: 'dividend',
          symbol,
          message: `${position.qty > 0 ? 'Dividend received' : 'Dividend paid (short)'}: $${amountPerShare.toFixed(2)}/share on ${Math.abs(position.qty)} ${symbol} (ex ${dateKey})`,
        },
      })
      settled++
    }
    return settled
  }
}

const g = globalThis as unknown as { __meridianDividends?: DividendService }

export function dividendService(): DividendService {
  if (!g.__meridianDividends) g.__meridianDividends = new DividendService()
  return g.__meridianDividends
}

export function resetDividendService(): void {
  g.__meridianDividends = undefined
}
