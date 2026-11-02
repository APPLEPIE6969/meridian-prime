import { consoleAuthed } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { candleCache } from '@/lib/market/candles'
import { isListed, normalizeSymbol } from '@/lib/universe'

// Console-side candle endpoint: same data as the agent /api/v1/market/candles
// route but authenticated with the operator desk session.

export async function GET(req: Request) {
  try {
    if (!consoleAuthed(req)) return fail(401, 'unauthorized', 'Operator session required')

    const url = new URL(req.url)
    const symbol = normalizeSymbol(url.searchParams.get('symbol') ?? '')
    if (!symbol) return fail(400, 'missing_symbol', 'Pass ?symbol=')
    if (!isListed(symbol)) return fail(404, 'unknown_symbol', `Symbol ${symbol} is not listed on this desk`)

    const interval = url.searchParams.get('interval') ?? '1d'
    const range = url.searchParams.get('range') ?? '5y'
    const bars = interval === '1m'
      ? await candleCache().intraday(symbol, '1d', '1m')
      : await candleCache().dailyHistory(symbol, range)

    return ok({ symbol, interval, count: bars.length, bars })
  } catch (err) {
    return handleError(err)
  }
}
