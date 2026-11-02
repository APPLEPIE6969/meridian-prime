import { agentFromRequest } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { db } from '@/lib/db'

export async function GET(req: Request) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const url = new URL(req.url)
    const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50), 200)
    const rows = await db().activity.findMany({
      where: { accountId: agent.id },
      orderBy: { ts: 'desc' },
      take: limit,
    })
    return ok({
      count: rows.length,
      activities: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        symbol: r.symbol,
        message: r.message,
        ts: r.ts.toISOString(),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
