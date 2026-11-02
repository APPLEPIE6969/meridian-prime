// Account math — Reg-T margin, settlement-aware cash, pattern day trader
// window, and agent provisioning.

import { createHash, randomBytes } from 'node:crypto'
import {
  DEFAULT_STARTING_CASH,
  INITIAL_MARGIN,
  MAINTENANCE_LONG,
  MAINTENANCE_SHORT,
  PDT_EQUITY_THRESHOLD,
  PDT_MAX_DAY_TRADES,
  PDT_WINDOW_BUSINESS_DAYS,
} from '../config'
import { addBusinessDays, etDateToUtc, sessionDateKey } from '../calendar'
import { now } from '../clock'
import { db } from '../db'
import { round2 } from '../money'

export type PriceFn = (symbol: string) => number | null

export interface AccountMetrics {
  kind: string
  cash: number
  settledCash: number
  unsettledCash: number
  longMarketValue: number
  shortMarketValue: number
  grossExposure: number
  equity: number
  initialRequirement: number
  maintenanceRequirement: number
  maintenanceExcess: number
  buyingPower: number
  dayTradeCount: number
  dayTradesRemaining: number
}

export function marginRequirement(
  lmv: number,
  smv: number,
): { initial: number; maintenance: number } {
  return {
    initial: round2(INITIAL_MARGIN * (lmv + smv)),
    maintenance: round2(MAINTENANCE_LONG * lmv + MAINTENANCE_SHORT * smv),
  }
}

export function dayTradeWindowStart(at = now()): Date {
  const todayKey = sessionDateKey(at)
  const startKey = addBusinessDays(todayKey, -(PDT_WINDOW_BUSINESS_DAYS - 1))
  return etDateToUtc(startKey, 0, 0)
}

export async function computeMetrics(accountId: string, priceOf: PriceFn): Promise<AccountMetrics | null> {
  const account = await db().account.findUnique({
    where: { id: accountId },
    include: { positions: true },
  })
  if (!account) return null

  const [ledgerGroups, dayTradeCount] = await Promise.all([
    db().cashLedger.groupBy({
      by: ['settled'],
      where: { accountId },
      _sum: { amount: true },
    }),
    db().dayTrade.count({
      where: { accountId, ts: { gte: dayTradeWindowStart() } },
    }),
  ])

  let cash = 0
  let settledCash = 0
  for (const group of ledgerGroups) {
    const sum = round2(group._sum.amount ?? 0)
    cash = round2(cash + sum)
    if (group.settled) settledCash = round2(settledCash + sum)
  }
  const unsettledCash = round2(cash - settledCash)

  let lmv = 0
  let smv = 0
  for (const position of account.positions) {
    const price = priceOf(position.symbol) ?? position.avgPrice
    const mv = round2(Math.abs(position.qty) * price)
    if (position.qty > 0) lmv = round2(lmv + mv)
    else smv = round2(smv + mv)
  }

  const gross = round2(lmv + smv)
  const equity = round2(cash + lmv - smv)
  const req = marginRequirement(lmv, smv)
  const maintenanceExcess = round2(equity - req.maintenance)
  const buyingPower = account.kind === 'margin'
    ? Math.max(0, round2(2 * (equity - 0.5 * gross)))
    : Math.max(0, settledCash)

  return {
    kind: account.kind,
    cash,
    settledCash,
    unsettledCash,
    longMarketValue: lmv,
    shortMarketValue: smv,
    grossExposure: gross,
    equity,
    initialRequirement: req.initial,
    maintenanceRequirement: req.maintenance,
    maintenanceExcess,
    buyingPower,
    dayTradeCount,
    dayTradesRemaining: Math.max(0, PDT_MAX_DAY_TRADES - dayTradeCount),
  }
}

export function isPdtRestricted(metrics: AccountMetrics): boolean {
  return metrics.kind === 'margin' && metrics.equity < PDT_EQUITY_THRESHOLD && metrics.dayTradesRemaining <= 0
}

export interface AgentCredentials {
  accountId: string
  name: string
  apiKey: string
  kind: string
  startingCash: number
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export async function createAgent(
  name: string,
  opts: { startingCash?: number; kind?: string } = {},
): Promise<AgentCredentials> {
  const apiKey = `mrp_live_${randomBytes(24).toString('hex')}`
  const startingCash = round2(opts.startingCash ?? DEFAULT_STARTING_CASH)
  const kind = opts.kind === 'cash' ? 'cash' : 'margin'
  if (!Number.isFinite(startingCash) || startingCash <= 0) {
    throw new Error('starting cash must be a positive amount')
  }
  const account = await db().account.create({
    data: {
      name,
      keyHash: hashKey(apiKey),
      keyPreview: `mrp_live_…${apiKey.slice(-4)}`,
      kind,
      startingCash,
    },
  })
  await db().cashLedger.create({
    data: { accountId: account.id, kind: 'deposit', amount: startingCash, settled: true },
  })
  await db().activity.create({
    data: { accountId: account.id, kind: 'account_opened', message: `Account opened with ${startingCash.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}` },
  })
  return { accountId: account.id, name: account.name, apiKey, kind, startingCash }
}

export async function findAccountByKey(apiKey: string) {
  if (typeof apiKey !== 'string' || apiKey.length < 8) return null
  return db().account.findUnique({ where: { keyHash: hashKey(apiKey) } })
}
