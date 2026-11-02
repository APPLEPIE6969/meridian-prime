import { agentFromRequest } from '@/lib/api/auth'
import { AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS, rateLimit } from '@/lib/api/ratelimit'
import { fail, handleError, ok } from '@/lib/api/respond'
import { candleCache } from '@/lib/market/candles'
import { isListed, normalizeSymbol } from '@/lib/universe'

const RANGES = new Set(['1d', '5d', '1mo', '6mo', '1y', '5y'])

export async function GET(req: Request) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const verdict = rateLimit(`candles:${agent.id}`, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS)
    if (!verdict.ok) {
      return fail(429, 'rate_limited', 'Too many requests', { retryAfter: verdict.retryAfter })
    }

    const url = new URL(req.url)
    const symbol = normalizeSymbol(url.searchParams.get('symbol') ?? '')
    if (!symbol) return fail(400, 'missing_symbol', 'Pass ?symbol=')
    if (!isListed(symbol)) return fail(404, 'unknown_symbol', `Symbol ${symbol} is not listed on this desk`)

    const interval = url.searchParams.get('interval') ?? '1d'
    const range = url.searchParams.get('range') ?? '5y'
    if (!RANGES.has(range)) return fail(400, 'invalid_range', `range must be one of ${[...RANGES].join(', ')}`)

    let bars
    if (interval === '1m') {
      bars = await candleCache().intraday(symbol, '1d', '1m')
    } else if (interval === '1d') {
      bars = await candleCache().dailyHistory(symbol, range)
    } else {
      return fail(400, 'invalid_interval', 'interval must be 1m or 1d')
    }

    return ok({ symbol, interval, range, count: bars.length, bars })
  } catch (err) {
    return handleError(err)
  }
}
