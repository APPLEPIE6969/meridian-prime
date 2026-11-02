import { consoleAuthed } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { tradingEngine } from '@/lib/engine/engine'
import { db } from '@/lib/db'
import { round2 } from '@/lib/money'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!consoleAuthed(req)) return fail(401, 'unauthorized', 'Operator session required')
    const { id } = await ctx.params

    const account = await db().account.findUnique({ where: { id } })
    if (!account) return fail(404, 'not_found', 'Agent not found')

    const engine = tradingEngine()
    const metrics = await engine.metrics(id)
    if (!metrics) return fail(404, 'not_found', 'Agent not found')

    const [positions, orders, fills, activities, snapshots] = await Promise.all([
      db().position.findMany({ where: { accountId: id }, orderBy: { symbol: 'asc' } }),
      engine.listOrders(id, { limit: 60 }),
      db().fill.findMany({ where: { accountId: id }, orderBy: { ts: 'desc' }, take: 60 }),
      db().activity.findMany({ where: { accountId: id }, orderBy: { ts: 'desc' }, take: 60 }),
      db().equitySnapshot.findMany({ where: { accountId: id }, orderBy: { ts: 'asc' }, take: 500 }),
    ])

    return ok({
      account: {
        id: account.id,
        name: account.name,
        kind: account.kind,
        keyPreview: account.keyPreview,
        startingCash: account.startingCash,
        createdAt: account.createdAt.toISOString(),
      },
      metrics,
      positions: positions.map((p) => {
        const last = engine.priceOf(p.symbol) ?? p.avgPrice
        const mv = round2(p.qty * last)
        return {
          symbol: p.symbol,
          qty: p.qty,
          avgPrice: p.avgPrice,
          last,
          marketValue: mv,
          unrealizedPnl: round2(mv - p.qty * p.avgPrice),
          realizedPnl: p.realizedPnl,
        }
      }),
      orders: orders.map((o) => ({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        orderType: o.orderType,
        qty: o.qty,
        limitPrice: o.limitPrice,
        tif: o.tif,
        status: o.status,
        filledQty: o.filledQty,
        avgFillPrice: o.avgFillPrice,
        createdAt: o.createdAt.toISOString(),
        fills: o.fills.map((f) => ({ qty: f.qty, price: f.price, fees: f.fees, ts: f.ts.toISOString() })),
      })),
      fills: fills.map((f) => ({
        id: f.id,
        orderId: f.orderId,
        symbol: f.symbol,
        side: f.side,
        qty: f.qty,
        price: f.price,
        fees: f.fees,
        ts: f.ts.toISOString(),
      })),
      activities: activities.map((a) => ({
        id: a.id,
        kind: a.kind,
        symbol: a.symbol,
        message: a.message,
        ts: a.ts.toISOString(),
      })),
      equityCurve: snapshots.map((s) => ({ ts: s.ts.toISOString(), equity: s.equity })),
    })
  } catch (err) {
    return handleError(err)
  }
}
