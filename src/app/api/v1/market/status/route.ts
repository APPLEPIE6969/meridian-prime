import { now } from '@/lib/clock'
import { sessionInfo } from '@/lib/calendar'
import { quoteService } from '@/lib/market/quotes'
import { ok } from '@/lib/api/respond'
import { UNIVERSE } from '@/lib/universe'

export async function GET() {
  const session = sessionInfo(now())
  const qs = quoteService()
  return ok({
    session: {
      state: session.state,
      label: session.label,
      earlyClose: session.earlyClose,
      nextOpen: session.nextOpen?.toISOString() ?? null,
      nextClose: session.nextClose?.toISOString() ?? null,
    },
    serverTime: now().toISOString(),
    marketData: {
      provider: 'live',
      symbolsTracked: UNIVERSE.length,
      quotesLive: qs.quoteCount(),
      lastPollAt: qs.lastPollAt ? new Date(qs.lastPollAt).toISOString() : null,
    },
  })
}
