import { agentFromRequest } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { tradingEngine } from '@/lib/engine/engine'
import { db } from '@/lib/db'
import { round2 } from '@/lib/money'

export async function GET(req: Request) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const engine = tradingEngine()
    const [positions, metrics] = await Promise.all([
      db().position.findMany({ where: { accountId: agent.id }, orderBy: { symbol: 'asc' } }),
      engine.metrics(agent.id),
    ])
    if (!metrics) return fail(404, 'account_not_found', 'Account not found')

    const rows = positions.map((p) => {
      const last = engine.priceOf(p.symbol) ?? p.avgPrice
      const mv = round2(p.qty * last)
      const costBasis = round2(p.qty * p.avgPrice)
      const unrealized = round2(mv - costBasis)
      return {
        symbol: p.symbol,
        qty: p.qty,
        avgPrice: p.avgPrice,
        last,
        marketValue: mv,
        costBasis,
        unrealizedPnl: unrealized,
        unrealizedPnlPct: costBasis !== 0 ? Math.round((unrealized / Math.abs(costBasis)) * 10000) / 10000 : 0,
        realizedPnl: p.realizedPnl,
        openedAt: p.openedAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      }
    })

    return ok({ positions: rows, totals: { longMarketValue: metrics.longMarketValue, shortMarketValue: metrics.shortMarketValue, equity: metrics.equity } })
  } catch (err) {
    return handleError(err)
  }
}
