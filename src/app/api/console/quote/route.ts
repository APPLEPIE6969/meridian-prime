import { consoleAuthed } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { quoteService } from '@/lib/market/quotes'
import { getInstrument } from '@/lib/universe'

export async function GET(req: Request) {
  try {
    if (!consoleAuthed(req)) return fail(401, 'unauthorized', 'Operator session required')

    const url = new URL(req.url)
    const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase()
    const instrument = getInstrument(symbol)
    if (!instrument) return fail(404, 'unknown_symbol', `Symbol ${symbol} is not listed on this desk`)
    const quote = quoteService().getQuote(symbol)
    if (!quote) return fail(404, 'quote_unavailable', 'No quote available yet')
    return ok({ ...instrument, quote })
  } catch (err) {
    return handleError(err)
  }
}
