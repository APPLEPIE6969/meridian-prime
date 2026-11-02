import { agentFromRequest } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { db } from '@/lib/db'

export async function GET(req: Request) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const url = new URL(req.url)
    const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? 500) || 500), 2000)
    const rows = await db().equitySnapshot.findMany({
      where: { accountId: agent.id },
      orderBy: { ts: 'asc' },
      take: limit,
    })
    return ok({
      count: rows.length,
      points: rows.map((r) => ({ ts: r.ts.toISOString(), equity: r.equity, cash: r.cash })),
    })
  } catch (err) {
    return handleError(err)
  }
}
