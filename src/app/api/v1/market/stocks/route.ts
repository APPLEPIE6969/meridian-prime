import { agentFromRequest } from '@/lib/api/auth'
import { AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS, rateLimit } from '@/lib/api/ratelimit'
import { fail, handleError, ok } from '@/lib/api/respond'
import { quoteService } from '@/lib/market/quotes'
import { SECTORS, UNIVERSE } from '@/lib/universe'

export async function GET(req: Request) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const verdict = rateLimit(`stocks:${agent.id}`, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS)
    if (!verdict.ok) {
      return fail(429, 'rate_limited', 'Too many requests', { retryAfter: verdict.retryAfter })
    }

    const qs = quoteService()
    const url = new URL(req.url)
    const sectorFilter = url.searchParams.get('sector')

    const rows = UNIVERSE
      .filter((i) => !sectorFilter || i.sector === sectorFilter)
      .map((i) => {
        const quote = qs.getQuote(i.symbol)
        const change = quote ? Math.round((quote.last - quote.prevClose) * 100) / 100 : null
        const changePct = quote && quote.prevClose > 0 ? Math.round((change! / quote.prevClose) * 10000) / 10000 : null
        return {
          ...i,
          quote: quote
            ? {
                last: quote.last,
                bid: quote.bid,
                ask: quote.ask,
                prevClose: quote.prevClose,
                change,
                changePct,
                dayHigh: quote.dayHigh,
                dayLow: quote.dayLow,
                dayVolume: quote.dayVolume,
              }
            : null,
        }
      })

    return ok({ sectors: SECTORS, count: rows.length, instruments: rows })
  } catch (err) {
    return handleError(err)
  }
}
