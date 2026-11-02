import { agentFromRequest } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { tradingEngine } from '@/lib/engine/engine'

export async function GET(req: Request) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const metrics = await tradingEngine().metrics(agent.id)
    if (!metrics) return fail(404, 'account_not_found', 'Account not found')
    return ok({
      ...metrics,
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      createdAt: agent.createdAt.toISOString(),
      startingCash: agent.startingCash,
    })
  } catch (err) {
    return handleError(err)
  }
}
