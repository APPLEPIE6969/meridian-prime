import { agentFromRequest } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { tradingEngine } from '@/lib/engine/engine'
import { db } from '@/lib/db'
import { round2 } from '@/lib/money'
import { getInstrument } from '@/lib/universe'

export async function GET(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const { symbol: raw } = await ctx.params
    const symbol = raw.toUpperCase()
    const instrument = getInstrument(symbol)
    if (!instrument) return fail(404, 'unknown_symbol', `Symbol ${symbol} is not listed on this desk`)

    const position = await db().position.findUnique({
      where: { accountId_symbol: { accountId: agent.id, symbol } },
    })
    if (!position) return fail(404, 'no_position', `No open position in ${symbol}`)

    const engine = tradingEngine()
    const last = engine.priceOf(symbol) ?? position.avgPrice
    const mv = round2(position.qty * last)
    return ok({
      symbol,
      qty: position.qty,
      avgPrice: position.avgPrice,
      last,
      marketValue: mv,
      unrealizedPnl: round2(mv - position.qty * position.avgPrice),
      realizedPnl: position.realizedPnl,
      openedAt: position.openedAt.toISOString(),
      updatedAt: position.updatedAt.toISOString(),
    })
  } catch (err) {
    return handleError(err)
  }
}
