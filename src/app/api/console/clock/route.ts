import { sessionInfo } from '@/lib/calendar'
import { now } from '@/lib/clock'
import { ok } from '@/lib/api/respond'

// Public clock endpoint — the console shell polls this on every page
// (including /login) to render the desk clock and session state without
// tripping auth redirects.

export async function GET() {
  const t = now()
  const session = sessionInfo(t)
  return ok({
    now: t.toISOString(),
    session: {
      state: session.state,
      label: session.label,
      nextOpen: session.nextOpen?.toISOString() ?? null,
      nextClose: session.nextClose?.toISOString() ?? null,
    },
  })
}
