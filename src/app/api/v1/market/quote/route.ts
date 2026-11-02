import { agentFromRequest } from '@/lib/api/auth'
import { AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS, rateLimit } from '@/lib/api/ratelimit'
import { fail, handleError, ok } from '@/lib/api/respond'
import { quoteService } from '@/lib/market/quotes'
import { normalizeSymbol } from '@/lib/universe'

export async function GET(req: Request) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const url = new URL(req.url)
    const symbol = normalizeSymbol(url.searchParams.get('symbol') ?? '')
    if (!symbol) return fail(400, 'missing_symbol', 'Pass ?symbol=')

    const verdict = rateLimit(`quote:${agent.id}`, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS)
    if (!verdict.ok) {
      return fail(429, 'rate_limited', 'Too many requests', { retryAfter: verdict.retryAfter })
    }

    const quote = quoteService().getQuote(symbol)
    if (!quote) return fail(404, 'quote_unavailable', 'No quote available for this symbol yet')
    return ok(quote)
  } catch (err) {
    return handleError(err)
  }
}
