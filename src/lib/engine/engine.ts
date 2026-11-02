// TradingEngine — order lifecycle, fills, positions, margin, PDT, forced
// liquidations, settlement and equity snapshots.
//
// The engine is event-driven off the live quote feed: every poll tick for a
// symbol walks that symbol's working orders against a shared per-tick
// liquidity budget. Outside regular hours nothing fills — limit orders wait
// for the open, day orders expire, market orders are rejected at placement.

import { addBusinessDays, closeMinuteFor, etDateToUtc, sessionDateKey, sessionInfo } from '../calendar'
import {
  INITIAL_MARGIN,
  PDT_EQUITY_THRESHOLD,
} from '../config'
import { now } from '../clock'
import { db } from '../db'
import { log } from '../log'
import { quoteService } from '../market/quotes'
import { newsWire } from '../market/news'
import { round2, round4, signedQty } from '../money'
import { relayPush } from '../relay'
import { getInstrument, normalizeSymbol } from '../universe'
import { computeMetrics, isPdtRestricted, type AccountMetrics, type PriceFn } from './accounts'
import { dividendService } from './dividends'
import { computeFees } from './fees'
import { fillCapacity, limitPlan, marketPlan } from './fills'

export class OrderError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'OrderError'
    this.code = code
    this.status = status
  }
}

export interface PlaceOrderInput {
  symbol: string
  side: string
  orderType: string
  qty: number
  limitPrice?: number | null
  tif?: string
}

export interface FillSummary {
  id: string
  orderId: string
  symbol: string
  side: string
  qty: number
  price: number
  fees: number
  ts: string
}

const WORKING = ['working', 'partially_filled']
const MAINTENANCE_INTERVAL_MS = 20_000
const SETTLEMENT_INTERVAL_MS = 30_000
const SNAPSHOT_INTERVAL_MS = 60_000

export class TradingEngine {
  private wired = false
  private timers: Array<ReturnType<typeof setInterval>> = []
  private lastMaintenanceSweep = 0
  private lastSettlementSweep = 0
  private lastSnapshotSweep = 0
  private lastExpiryCheck = ''

  // ── market wiring ────────────────────────────────────────────────────────

  wireMarketFeed(): void {
    if (this.wired) return
    this.wired = true
    quoteService().onTick((symbol, quote) => this.onQuote(symbol, quote))
  }

  priceOf: PriceFn = (symbol: string): number | null => {
    return quoteService().getQuote(symbol)?.last ?? null
  }

  // ── order placement ──────────────────────────────────────────────────────

  async placeOrder(accountId: string, input: PlaceOrderInput) {
    const symbol = normalizeSymbol(String(input.symbol ?? ''))
    if (!getInstrument(symbol)) {
      throw new OrderError('unknown_symbol', `Symbol ${symbol} is not listed on this desk`, 404)
    }
    const side = String(input.side ?? '')
    if (side !== 'buy' && side !== 'sell') {
      throw new OrderError('invalid_side', 'side must be "buy" or "sell"')
    }
    const qty = Number(input.qty)
    if (!Number.isInteger(qty) || qty < 1 || qty > 10_000_000) {
      throw new OrderError('invalid_qty', 'qty must be a whole number of shares between 1 and 10,000,000')
    }
    const orderType = String(input.orderType ?? '')
    if (orderType !== 'market' && orderType !== 'limit') {
      throw new OrderError('invalid_order_type', 'orderType must be "market" or "limit"')
    }
    let limitPrice: number | null = null
    if (orderType === 'limit') {
      limitPrice = round4(Number(input.limitPrice))
      if (!Number.isFinite(limitPrice) || limitPrice! <= 0 || limitPrice! > 1_000_000) {
        throw new OrderError('invalid_limit_price', 'limitPrice must be a positive price below 1,000,000')
      }
    }
    const tif = String(input.tif ?? 'day')
    if (tif !== 'day' && tif !== 'gtc') {
      throw new OrderError('invalid_tif', 'tif must be "day" or "gtc"')
    }

    const account = await db().account.findUnique({
      where: { id: accountId },
      include: { positions: true },
    })
    if (!account) throw new OrderError('account_not_found', 'Account not found', 404)

    const session = sessionInfo(now())
    if (orderType === 'market' && session.state !== 'open') {
      throw new OrderError(
        'market_closed',
        'Market orders are accepted only during regular hours — route a limit order if you want to work for the open',
        422,
      )
    }

    const quote = quoteService().getQuote(symbol)
    if (!quote) {
      throw new OrderError('quote_unavailable', 'No market data for this symbol yet — try again shortly', 503)
    }

    const position = account.positions.find((p) => p.symbol === symbol)
    const currentQty = position?.qty ?? 0
    const projected = currentQty + signedQty(side, qty)
    if (account.kind === 'cash' && projected < 0) {
      throw new OrderError('shorting_requires_margin', 'Short sales require a margin account', 422)
    }

    const metrics = await computeMetrics(account.id, this.priceOf)
    if (!metrics) throw new OrderError('account_not_found', 'Account not found', 404)

    // Pattern day trader check: a closing sell that would complete another
    // day trade inside the rolling window on a sub-$25k margin account.
    if (isPdtRestricted(metrics)) {
      const opensToday = await this.hasOpeningFillToday(accountId, symbol)
      const isClosingSale = side === 'sell' && currentQty > 0
      if (isClosingSale && opensToday) {
        throw new OrderError(
          'pdt_restricted',
          `Pattern day trader limit reached: ${metrics.dayTradeCount} day trades in the last 5 business days on an account under $25,000 equity`,
          422,
        )
      }
    }

    // Buying power: Reg-T initial requirement on post-trade gross exposure
    // for margin accounts; settled cash for cash accounts.
    const estPrice = orderType === 'limit' ? limitPrice! : side === 'buy' ? quote.ask : quote.bid
    const cost = round2(qty * estPrice)
    if (side === 'buy' || projected < 0) {
      if (account.kind === 'margin') {
        const postGross = round2(metrics.grossExposure + cost)
        if (metrics.equity < INITIAL_MARGIN * postGross) {
          throw new OrderError(
            'insufficient_buying_power',
            `Order cost $${cost.toLocaleString('en-US')} exceeds buying power $${metrics.buyingPower.toLocaleString('en-US')}`,
            422,
          )
        }
      } else if (cost > metrics.settledCash) {
        throw new OrderError(
          'insufficient_buying_power',
          `Order cost $${cost.toLocaleString('en-US')} exceeds settled cash $${metrics.settledCash.toLocaleString('en-US')}`,
          422,
        )
      }
    }

    const expiresAt = tif === 'day' ? this.dayExpiry(session) : null
    const created = await db().order.create({
      data: {
        accountId,
        symbol,
        side,
        orderType,
        qty,
        limitPrice,
        tif,
        status: 'working',
        expiresAt,
      },
    })
    const description = `${side.toUpperCase()} ${qty} ${symbol} ${orderType}${limitPrice ? ` @ ${limitPrice.toFixed(2)}` : ''} · ${tif.toUpperCase()}`
    await db().activity.create({
      data: { accountId, kind: 'order_placed', symbol, message: `Order placed: ${description}`, meta: JSON.stringify({ orderId: created.id }) },
    })
    relayPush('activity', { accountId, kind: 'order_placed', symbol, message: `Order placed: ${description}` })

    if (session.state === 'open') {
      await this.processSymbol(symbol)
    }
    return this.getOrder(accountId, created.id)
  }

  private dayExpiry(session: ReturnType<typeof sessionInfo>): Date {
    const closeMin = closeMinuteFor(session.dateKey)
    const expiry = etDateToUtc(session.dateKey, Math.floor(closeMin / 60), closeMin % 60)
    return expiry.getTime() > now().getTime() ? expiry : etDateToUtc(addBusinessDays(session.dateKey, 1), Math.floor(closeMin / 60), closeMin % 60)
  }

  // ── order management ─────────────────────────────────────────────────────

  async cancelOrder(accountId: string, orderId: string) {
    const order = await db().order.findUnique({ where: { id: orderId } })
    if (!order || order.accountId !== accountId) {
      throw new OrderError('order_not_found', 'Order not found', 404)
    }
    if (!WORKING.includes(order.status)) {
      throw new OrderError('not_cancellable', `Order is already ${order.status}`, 409)
    }
    const updated = await db().order.update({
      where: { id: orderId },
      data: { status: 'canceled' },
    })
    await db().activity.create({
      data: { accountId, kind: 'order_canceled', symbol: order.symbol, message: `Order canceled: ${order.side.toUpperCase()} ${order.qty - order.filledQty} of ${order.qty} ${order.symbol}`, meta: JSON.stringify({ orderId }) },
    })
    relayPush('activity', { accountId, kind: 'order_canceled', symbol: order.symbol, message: `Order canceled: ${order.side.toUpperCase()} ${order.qty - order.filledQty} of ${order.qty} ${order.symbol}` })
    return updated
  }

  async getOrder(accountId: string, orderId: string) {
    const order = await db().order.findUnique({ where: { id: orderId }, include: { fills: true } })
    if (!order || order.accountId !== accountId) {
      throw new OrderError('order_not_found', 'Order not found', 404)
    }
    return order
  }

  async listOrders(accountId: string, opts: { status?: string; symbol?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200)
    const where: Record<string, unknown> = { accountId }
    if (opts.status) where.status = opts.status
    if (opts.symbol) where.symbol = normalizeSymbol(opts.symbol)
    return db().order.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, include: { fills: true } })
  }

  // ── the quote tick ───────────────────────────────────────────────────────

  async onQuote(symbol: string, _quote?: { symbol: string }): Promise<void> {
    const session = sessionInfo(now())
    if (session.state !== 'open') {
      await this.expireDayOrders(session)
      return
    }
    if (this.lastExpiryCheck !== session.dateKey) {
      // First tick of a session: day orders carried over from a previous
      // session die at the open (covers downtime through the close).
      this.lastExpiryCheck = session.dateKey
      await this.expireDayOrders(session)
    }
    await this.processSymbol(symbol)

    const t = Date.now()
    if (t - this.lastMaintenanceSweep > MAINTENANCE_INTERVAL_MS) {
      this.lastMaintenanceSweep = t
      await this.maintenanceSweep()
    }
    if (t - this.lastSettlementSweep > SETTLEMENT_INTERVAL_MS) {
      this.lastSettlementSweep = t
      await this.settlementSweep()
    }
    if (t - this.lastSnapshotSweep > SNAPSHOT_INTERVAL_MS) {
      this.lastSnapshotSweep = t
      await this.snapshotSweep()
    }
  }

  private async expireDayOrders(session: ReturnType<typeof sessionInfo>): Promise<void> {
    const stale = await db().order.findMany({
      where: { status: { in: WORKING }, tif: 'day' },
    })
    for (const order of stale) {
      const createdKey = sessionDateKey(order.createdAt)
      const fromPreviousSession = createdKey !== session.dateKey
      // In an open session only orders from previous sessions die (same-day
      // orders keep working); after the close every day order does.
      if (session.state === 'post_market' || fromPreviousSession) {
        await db().order.update({ where: { id: order.id }, data: { status: 'expired' } })
        await db().activity.create({
          data: { accountId: order.accountId, kind: 'order_expired', symbol: order.symbol, message: `Day order expired at close: ${order.side.toUpperCase()} ${order.qty - order.filledQty} of ${order.qty} ${order.symbol}`, meta: JSON.stringify({ orderId: order.id }) },
        })
      }
    }
  }

  private async processSymbol(symbol: string): Promise<void> {
    const orders = await db().order.findMany({
      where: { symbol, status: { in: WORKING } },
      orderBy: { createdAt: 'asc' },
    })
    if (orders.length === 0) return

    const qs = quoteService()
    const live = qs.getQuote(symbol)
    if (!live) return
    const minuteVolume = qs.minuteVolume(symbol)
    let capacityLeft = fillCapacity(minuteVolume, live.dayVolume)

    for (const order of orders) {
      if (capacityLeft < 1) break
      const remaining = order.qty - order.filledQty
      if (remaining < 1) continue
      const plan = order.orderType === 'limit'
        ? limitPlan(order.side, remaining, order.limitPrice!, live, capacityLeft)
        : marketPlan(order.side, remaining, live, capacityLeft)

      // Both plan builders emit exactly one fill with qty >= 1, and the
      // capacityLeft check above guarantees the budget is still >= 1 here,
      // so `take` can never drop below 1 inside this loop.
      for (const fill of plan.fills) {
        const take = Math.min(fill.qty, capacityLeft)
        await this.applyFill(order, { qty: take, price: fill.price })
        capacityLeft -= take
      }
    }
  }

  private async applyFill(
    order: { id: string; accountId: string; symbol: string; side: string; orderType: string; qty: number; filledQty: number; avgFillPrice: number | null },
    fill: { qty: number; price: number },
  ): Promise<void> {
    const fees = computeFees(order.side, fill.qty, fill.price)
    const gross = round2(fill.qty * fill.price)

    const account = await db().account.findUnique({ where: { id: order.accountId } })
    if (!account) {
      log('error', 'fill skipped: account missing', { orderId: order.id, accountId: order.accountId })
      return
    }

    const prevPosition = await db().position.findUnique({
      where: { accountId_symbol: { accountId: order.accountId, symbol: order.symbol } },
    })
    const prevQty = prevPosition?.qty ?? 0
    const prevAvg = prevPosition?.avgPrice ?? 0
    const prevRealized = prevPosition?.realizedPnl ?? 0

    const delta = signedQty(order.side, fill.qty)
    const newQty = prevQty + delta
    let avgPrice = prevAvg
    let realized = 0

    if (prevQty === 0 || Math.sign(prevQty) === Math.sign(delta)) {
      // Opening or adding: weighted average price.
      avgPrice = (Math.abs(prevQty) * prevAvg + fill.qty * fill.price) / (Math.abs(prevQty) + fill.qty)
    } else {
      // Closing (possibly through zero).
      const closedQty = Math.min(Math.abs(prevQty), fill.qty)
      realized = round2((fill.price - prevAvg) * closedQty * (prevQty > 0 ? 1 : -1))
      avgPrice = Math.abs(delta) > Math.abs(prevQty) ? fill.price : prevAvg
    }

    if (Math.abs(newQty) < 1e-9) {
      if (prevPosition) await db().position.delete({ where: { id: prevPosition.id } })
    } else if (prevPosition) {
      await db().position.update({
        where: { id: prevPosition.id },
        data: { qty: newQty, avgPrice, realizedPnl: round2(prevRealized + realized) },
      })
    } else {
      await db().position.create({
        data: { accountId: order.accountId, symbol: order.symbol, qty: newQty, avgPrice, realizedPnl: realized },
      })
    }

    // Cash: T+1 settlement on both sides of the trade plus fees.
    const settleKey = addBusinessDays(sessionDateKey(now()), 1)
    const settleDate = etDateToUtc(settleKey, 17, 0)
    await db().cashLedger.create({
      data: {
        accountId: order.accountId,
        kind: 'trade',
        amount: order.side === 'buy' ? -gross : gross,
        settled: false,
        settleDate,
        ref: order.id,
      },
    })
    if (fees.total > 0) {
      await db().cashLedger.create({
        data: { accountId: order.accountId, kind: 'fee', amount: -fees.total, settled: false, settleDate, ref: order.id },
      })
    }

    await db().fill.create({
      data: {
        orderId: order.id,
        accountId: order.accountId,
        symbol: order.symbol,
        side: order.side,
        qty: fill.qty,
        price: fill.price,
        fees: fees.total,
      },
    })

    // Day-trade detection (margin accounts): a sell that reduces a long
    // position which was opened earlier the same session.
    if (account.kind === 'margin' && order.side === 'sell' && prevQty > 0 && newQty < prevQty) {
      if (await this.hasOpeningFillToday(order.accountId, order.symbol)) {
        await db().dayTrade.create({ data: { accountId: order.accountId, symbol: order.symbol, ts: now() } })
      }
    }

    const newFilledQty = order.filledQty + fill.qty // fill.qty >= 1, so this is >= 1
    const prevAvgFill = order.avgFillPrice ?? 0
    const newAvgFill = (prevAvgFill * order.filledQty + fill.price * fill.qty) / newFilledQty
    await db().order.update({
      where: { id: order.id },
      data: {
        filledQty: newFilledQty,
        avgFillPrice: round4(newAvgFill),
        status: newFilledQty >= order.qty ? 'filled' : 'partially_filled',
      },
    })

    await db().activity.create({
      data: {
        accountId: order.accountId,
        kind: 'fill',
        symbol: order.symbol,
        message: `${newFilledQty >= order.qty ? 'Filled' : 'Partial fill'}: ${order.side.toUpperCase()} ${fill.qty} ${order.symbol} @ $${fill.price.toFixed(2)}${fees.total > 0 ? ` · fees $${fees.total.toFixed(2)}` : ''}`,
        meta: JSON.stringify({ orderId: order.id, fillQty: fill.qty, price: fill.price }),
      },
    })
    relayPush('activity', {
      accountId: order.accountId,
      kind: 'fill',
      symbol: order.symbol,
      message: `${newFilledQty >= order.qty ? 'Filled' : 'Partial fill'}: ${order.side.toUpperCase()} ${fill.qty} ${order.symbol} @ $${fill.price.toFixed(2)}`,
    })
    await this.snapshotAccount(order.accountId)
  }

  private async hasOpeningFillToday(accountId: string, symbol: string): Promise<boolean> {
    const session = sessionInfo(now())
    const openTs = etDateToUtc(session.dateKey, 9, 30)
    const buy = await db().fill.findFirst({
      where: { accountId, symbol, side: 'buy', ts: { gte: openTs } },
    })
    return buy !== null
  }

  // ── risk sweeps ──────────────────────────────────────────────────────────

  async maintenanceSweep(): Promise<number> {
    const accounts = await db().account.findMany()
    let liquidated = 0
    for (const account of accounts) {
      const metrics = await computeMetrics(account.id, this.priceOf)
      if (!metrics || metrics.maintenanceExcess >= 0) continue
      if (!quoteService().getQuote('AAPL')) continue // no market data yet — cannot liquidate
      const positions = await db().position.findMany({
        where: { accountId: account.id, NOT: { qty: 0 } },
      })
      const priced = positions
        .map((p) => ({ position: p, price: this.priceOf(p.symbol) ?? p.avgPrice }))
        .sort((a, b) => Math.abs(b.position.qty) * b.price - Math.abs(a.position.qty) * a.price)

      await db().activity.create({
        data: {
          accountId: account.id,
          kind: 'margin_call',
          message: `Margin call: equity $${metrics.equity.toFixed(2)} below maintenance requirement $${metrics.maintenanceRequirement.toFixed(2)} — liquidating`,
        },
      })
      relayPush('activity', { accountId: account.id, kind: 'margin_call', message: 'Margin call — forced liquidation in progress' })

      let excess = metrics.maintenanceExcess
      for (const { position } of priced) {
        if (excess >= 0) break
        const quote = quoteService().getQuote(position.symbol)
        if (!quote) continue
        // Reduce by a third of the position at a time until the account is
        // comfortably above maintenance.
        let remainingToClose = Math.abs(position.qty)
        let slices = 0
        while (remainingToClose >= 1 && excess < 0 && slices < 12) {
          slices++
          const qty = Math.min(remainingToClose, Math.max(1, Math.ceil(remainingToClose / 3)))
          const side = position.qty > 0 ? 'sell' : 'buy'
          const order = await db().order.create({
            data: {
              accountId: account.id,
              symbol: position.symbol,
              side,
              orderType: 'market',
              qty,
              tif: 'day',
              status: 'working',
            },
          })
          await db().activity.create({
            data: {
              accountId: account.id,
              kind: 'forced_liquidation',
              symbol: position.symbol,
              message: `Forced liquidation: ${side.toUpperCase()} ${qty} ${position.symbol}`,
              meta: JSON.stringify({ orderId: order.id }),
            },
          })
          await this.processSymbol(position.symbol)
          const after = await computeMetrics(account.id, this.priceOf)
          excess = after ? after.maintenanceExcess : 0
          remainingToClose -= qty
          liquidated++
        }
      }
    }
    return liquidated
  }

  async settlementSweep(): Promise<number> {
    const rows = await db().cashLedger.updateMany({
      where: { settled: false, settleDate: { lte: now() } },
      data: { settled: true },
    })
    return rows.count
  }

  async snapshotAccount(accountId: string): Promise<void> {
    const metrics = await computeMetrics(accountId, this.priceOf)
    if (!metrics) return
    await db().equitySnapshot.create({
      data: { accountId, equity: metrics.equity, cash: metrics.cash },
    })
  }

  async snapshotSweep(): Promise<number> {
    const accounts = await db().account.findMany({ select: { id: true } })
    for (const account of accounts) {
      await this.snapshotAccount(account.id)
    }
    return accounts.length
  }

  async metrics(accountId: string): Promise<AccountMetrics | null> {
    return computeMetrics(accountId, this.priceOf)
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  startLoops(): void {
    this.wireMarketFeed()
    quoteService().start()
    newsWire().start()
    this.timers.push(
      setInterval(() => {
        void this.maintenanceSweep().catch((err) => log('warn', 'maintenance sweep failed', { error: err instanceof Error ? err.message : String(err) }))
      }, MAINTENANCE_INTERVAL_MS),
      setInterval(() => {
        void this.settlementSweep().catch((err) => log('warn', 'settlement sweep failed', { error: err instanceof Error ? err.message : String(err) }))
        void this.snapshotSweep().catch((err) => log('warn', 'snapshot sweep failed', { error: err instanceof Error ? err.message : String(err) }))
      }, SETTLEMENT_INTERVAL_MS),
      setInterval(() => {
        void dividendService().sweep().catch((err) => log('warn', 'dividend sweep failed', { error: err instanceof Error ? err.message : String(err) }))
      }, 5 * 60_000),
    )
    for (const timer of this.timers) timer.unref?.()
  }

  stopLoops(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    quoteService().stop()
    newsWire().stop()
  }
}

const g = globalThis as unknown as { __meridianEngine?: TradingEngine }

export function tradingEngine(): TradingEngine {
  if (!g.__meridianEngine) g.__meridianEngine = new TradingEngine()
  return g.__meridianEngine
}

export function resetTradingEngine(): void {
  g.__meridianEngine?.stopLoops()
  g.__meridianEngine = undefined
}
