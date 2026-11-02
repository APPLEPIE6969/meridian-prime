import { isEarlyClose, isTradingDay, sessionInfo, upcomingHolidays } from '@/lib/calendar'
import { etParts } from '@/lib/calendar'
import { now } from '@/lib/clock'
import { ok } from '@/lib/api/respond'

export async function GET() {
  const t = now()
  const session = sessionInfo(t)
  const parts = etParts(t)
  const todayHours = isTradingDay(session.dateKey)
    ? { open: '09:30', close: isEarlyClose(session.dateKey) ? '13:00' : '16:00' }
    : null
  return ok({
    today: {
      dateKey: session.dateKey,
      tradingDay: isTradingDay(session.dateKey),
      earlyClose: isEarlyClose(session.dateKey),
      regularHours: todayHours,
      state: session.state,
      label: session.label,
      localTime: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} ET`,
    },
    regularSchedule: {
      preMarket: { open: '04:00', close: '09:30' },
      regular: { open: '09:30', close: '16:00' },
      afterHours: { open: '16:00', close: '20:00' },
      earlyCloseTime: '13:00',
    },
    upcomingHolidays: upcomingHolidays(t, 8),
  })
}
