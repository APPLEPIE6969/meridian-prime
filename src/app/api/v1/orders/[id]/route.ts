import { agentFromRequest } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { tradingEngine } from '@/lib/engine/engine'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')
    const { id } = await ctx.params
    const order = await tradingEngine().getOrder(agent.id, id)
    return ok({
      ...order,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      expiresAt: order.expiresAt?.toISOString() ?? null,
      fills: order.fills.map((f) => ({ id: f.id, qty: f.qty, price: f.price, fees: f.fees, ts: f.ts.toISOString() })),
    })
  } catch (err) {
    return handleError(err)
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')
    const { id } = await ctx.params
    const canceled = await tradingEngine().cancelOrder(agent.id, id)
    return ok({ id: canceled.id, status: canceled.status })
  } catch (err) {
    return handleError(err)
  }
}
