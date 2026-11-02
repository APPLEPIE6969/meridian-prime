import { consoleAuthed } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { newsWire } from '@/lib/market/news'
import { normalizeSymbol } from '@/lib/universe'

export async function GET(req: Request) {
  try {
    if (!consoleAuthed(req)) return fail(401, 'unauthorized', 'Operator session required')
    const url = new URL(req.url)
    const symbol = normalizeSymbol(url.searchParams.get('symbol') ?? '')
    const limit = Number(url.searchParams.get('limit') ?? 15) || 15
    const headlines = await newsWire().latest({
      symbols: symbol ? [symbol] : undefined,
      limit: Math.min(limit, 50),
    })
    return ok({ count: headlines.length, headlines })
  } catch (err) {
    return handleError(err)
  }
}
