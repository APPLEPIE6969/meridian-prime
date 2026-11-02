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
    const positions = await db().position.findMany({ where: { accountId: agent.id }, orderBy: { symbol: 'asc' } })
    const rows = positions.map((p) => {
      const last = engine.priceOf(p.symbol) ?? p.avgPrice
      const mv = round2(p.qty * last)
      return {
        symbol: p.symbol,
        qty: p.qty,
        avgPrice: p.avgPrice,
        last,
        marketValue: mv,
        unrealizedPnl: round2(mv - p.qty * p.avgPrice),
      }
    })
    return ok({ count: rows.length, positions: rows })
  } catch (err) {
    return handleError(err)
  }
}
