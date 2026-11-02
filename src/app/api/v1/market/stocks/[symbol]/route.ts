import { agentFromRequest } from '@/lib/api/auth'
import { AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS, rateLimit } from '@/lib/api/ratelimit'
import { fail, handleError, ok } from '@/lib/api/respond'
import { quoteService } from '@/lib/market/quotes'
import { getInstrument } from '@/lib/universe'
import { candleCache } from '@/lib/market/candles'

export async function GET(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const verdict = rateLimit(`stock:${agent.id}`, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS)
    if (!verdict.ok) {
      return fail(429, 'rate_limited', 'Too many requests', { retryAfter: verdict.retryAfter })
    }

    const { symbol: raw } = await ctx.params
    const instrument = getInstrument(raw)
    if (!instrument) return fail(404, 'unknown_symbol', `Symbol ${raw.toUpperCase()} is not listed on this desk`)

    const quote = quoteService().getQuote(instrument.symbol)
    let yearHigh: number | null = null
    let yearLow: number | null = null
    try {
      const daily = await candleCache().dailyHistory(instrument.symbol, '1y')
      if (daily.length > 0) {
        yearHigh = Math.max(...daily.map((b) => b.h))
        yearLow = Math.min(...daily.map((b) => b.l))
      }
    } catch {
      // history is optional metadata for this endpoint
    }

    return ok({ ...instrument, quote, range52w: { high: yearHigh, low: yearLow } })
  } catch (err) {
    return handleError(err)
  }
}
