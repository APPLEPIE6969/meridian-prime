import { agentFromRequest } from '@/lib/api/auth'
import { AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS, rateLimit } from '@/lib/api/ratelimit'
import { fail, handleError, ok } from '@/lib/api/respond'
import { newsWire } from '@/lib/market/news'
import { normalizeSymbol } from '@/lib/universe'

export async function GET(req: Request) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const verdict = rateLimit(`news:${agent.id}`, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS)
    if (!verdict.ok) {
      return fail(429, 'rate_limited', 'Too many requests', { retryAfter: verdict.retryAfter })
    }

    const url = new URL(req.url)
    const symbolParam = url.searchParams.get('symbol')
    const limit = Number(url.searchParams.get('limit') ?? 25)
    const symbols = symbolParam
      ? symbolParam.split(',').map((s) => normalizeSymbol(s)).filter(Boolean)
      : undefined

    const headlines = await newsWire().latest({ symbols, limit: Number.isFinite(limit) ? limit : 25 })
    return ok({ count: headlines.length, headlines })
  } catch (err) {
    return handleError(err)
  }
}
