import { now } from '@/lib/clock'
import { cfg } from '@/lib/config'
import { sessionInfo } from '@/lib/calendar'
import { quoteService } from '@/lib/market/quotes'
import { ok } from '@/lib/api/respond'
import { dataHealth } from '@/lib/provider'
import { UNIVERSE } from '@/lib/universe'

export async function GET() {
  const session = sessionInfo(now())
  const qs = quoteService()
  const fixture = cfg().dataProvider === 'fixture'
  const health = dataHealth()
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
      provider: fixture ? 'fixture' : (health.active ?? 'live'),
      symbolsTracked: UNIVERSE.length,
      quotesLive: qs.quoteCount(),
      lastPollAt: qs.lastPollAt ? new Date(qs.lastPollAt).toISOString() : null,
      sources: fixture
        ? []
        : health.sources.map((s) => ({
            name: s.name,
            failures: s.failures,
            lastError: s.lastError,
            lastSuccessAt: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
          })),
    },
  })
}
