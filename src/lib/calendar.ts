// US equity market calendar — real NYSE sessions.
//
// Full-day closures and 1:00 p.m. early closes are the published NYSE
// calendar for 2024–2027 (including the Jan 9, 2025 national day of mourning
// for President Carter, Saturday-holiday observance shifts, and Good Friday
// dates derived from the Easter tables). All wall-clock math goes through
// Intl with the America/New_York timezone, so DST transitions are handled by
// the platform rather than by hand-rolled offset tables.

export type SessionState = 'pre_market' | 'open' | 'post_market' | 'closed'

export interface EtParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number // 0=Sun … 6=Sat
  dateKey: string // YYYY-MM-DD in exchange local time
}

export interface SessionInfo {
  state: SessionState
  dateKey: string
  earlyClose: boolean
  nextOpen: Date | null
  nextClose: Date | null
  label: string
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
})

export function etParts(d: Date): EtParts {
  const parts = etFormatter.formatToParts(d)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const hour = Number(get('hour')) % 24
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
  }
}

/** Convert an exchange-local wall time to the UTC instant it denotes. */
export function etDateToUtc(dateKey: string, hourEt: number, minuteEt: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number)
  for (const offset of [-5, -4]) {
    const utc = Date.UTC(y, m - 1, d, hourEt - offset, minuteEt)
    const p = etParts(new Date(utc))
    if (p.year === y && p.month === m && p.day === d && p.hour === hourEt && p.minute === minuteEt) {
      return new Date(utc)
    }
  }
  // Unreachable for the times this module uses (09:30 / 13:00 / 16:00 / 20:00
  // all exist on every calendar day), but keep a deterministic fallback.
  return new Date(Date.UTC(y, m - 1, d, hourEt + 5, minuteEt))
}

// ── Published NYSE closures, 2024–2027 ───────────────────────────────────────

export const HOLIDAY_NAMES: Record<string, string> = {
  // 2024
  '2024-01-01': "New Year's Day",
  '2024-01-15': 'Martin Luther King, Jr. Day',
  '2024-02-19': "Washington's Birthday",
  '2024-03-29': 'Good Friday',
  '2024-05-27': 'Memorial Day',
  '2024-06-19': 'Juneteenth National Independence Day',
  '2024-07-04': 'Independence Day',
  '2024-09-02': 'Labor Day',
  '2024-11-28': 'Thanksgiving Day',
  '2024-12-25': 'Christmas Day',
  // 2025 (includes the Jan 9 national day of mourning for President Carter)
  '2025-01-01': "New Year's Day",
  '2025-01-09': 'National Day of Mourning for President Jimmy Carter',
  '2025-01-20': 'Martin Luther King, Jr. Day',
  '2025-02-17': "Washington's Birthday",
  '2025-04-18': 'Good Friday',
  '2025-05-26': 'Memorial Day',
  '2025-06-19': 'Juneteenth National Independence Day',
  '2025-07-04': 'Independence Day',
  '2025-09-01': 'Labor Day',
  '2025-11-27': 'Thanksgiving Day',
  '2025-12-25': 'Christmas Day',
  // 2026
  '2026-01-01': "New Year's Day",
  '2026-01-19': 'Martin Luther King, Jr. Day',
  '2026-02-16': "Washington's Birthday",
  '2026-04-03': 'Good Friday',
  '2026-05-25': 'Memorial Day',
  '2026-06-19': 'Juneteenth National Independence Day',
  '2026-07-03': 'Independence Day (observed)',
  '2026-09-07': 'Labor Day',
  '2026-11-26': 'Thanksgiving Day',
  '2026-12-25': 'Christmas Day',
  // 2027
  '2027-01-01': "New Year's Day",
  '2027-01-18': 'Martin Luther King, Jr. Day',
  '2027-02-15': "Washington's Birthday",
  '2027-03-26': 'Good Friday',
  '2027-05-31': 'Memorial Day',
  '2027-06-18': 'Juneteenth National Independence Day (observed)',
  '2027-07-05': 'Independence Day (observed)',
  '2027-09-06': 'Labor Day',
  '2027-11-25': 'Thanksgiving Day',
  '2027-12-24': 'Christmas Day (observed)',
}

/** 1:00 p.m. ET early closes (day after Thanksgiving, eve of an observed
 * Independence/Christmas holiday when that eve is a regular session). */
export const EARLY_CLOSES = new Set([
  '2024-07-03',
  '2024-11-29',
  '2024-12-24',
  '2025-07-03',
  '2025-11-28',
  '2025-12-24',
  '2026-07-02',
  '2026-11-27',
  '2026-12-24',
  '2027-07-02',
  '2027-11-26',
  '2027-12-23',
])

const HOLIDAYS = new Set(Object.keys(HOLIDAY_NAMES))

export function isTradingDay(dateKey: string): boolean {
  const [y, m, d] = dateKey.split('-').map(Number)
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  return !HOLIDAYS.has(dateKey)
}

export function isEarlyClose(dateKey: string): boolean {
  return EARLY_CLOSES.has(dateKey)
}

/** Regular-session close in exchange-local minutes (13:00 early, else 16:00). */
export function closeMinuteFor(dateKey: string): number {
  return isEarlyClose(dateKey) ? 13 * 60 : 16 * 60
}

export function nextTradingDay(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const cursor = new Date(Date.UTC(y, m - 1, d))
  for (let i = 0; i < 400; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    const key = cursor.toISOString().slice(0, 10)
    if (isTradingDay(key)) return key
  }
  return dateKey
}

export function addBusinessDays(dateKey: string, n: number): string {
  let key = dateKey
  const step = n >= 0 ? 1 : -1
  let remaining = Math.abs(n)
  while (remaining > 0) {
    const [y, m, d] = key.split('-').map(Number)
    const cursor = new Date(Date.UTC(y, m - 1, d))
    cursor.setUTCDate(cursor.getUTCDate() + step)
    key = cursor.toISOString().slice(0, 10)
    if (isTradingDay(key)) remaining--
  }
  return key
}

/** Full session state for a moment: phase, next open, next close, human label. */
export function sessionInfo(at: Date): SessionInfo {
  const p = etParts(at)
  const minutes = p.hour * 60 + p.minute
  const todayOpen = isTradingDay(p.dateKey)
  const closeMin = closeMinuteFor(p.dateKey)

  const nextOpenFrom = (key: string): Date => etDateToUtc(nextTradingDay(key), 9, 30)

  let state: SessionState
  let nextOpen: Date | null = null
  let nextClose: Date | null = null

  if (!todayOpen) {
    state = 'closed'
    nextOpen = nextOpenFrom(p.dateKey)
  } else if (minutes < 4 * 60) {
    state = 'closed'
    nextOpen = etDateToUtc(p.dateKey, 9, 30)
    nextClose = etDateToUtc(p.dateKey, Math.floor(closeMin / 60), closeMin % 60)
  } else if (minutes < 9 * 60 + 30) {
    state = 'pre_market'
    nextOpen = etDateToUtc(p.dateKey, 9, 30)
    nextClose = etDateToUtc(p.dateKey, Math.floor(closeMin / 60), closeMin % 60)
  } else if (minutes < closeMin) {
    state = 'open'
    nextOpen = null
    nextClose = etDateToUtc(p.dateKey, Math.floor(closeMin / 60), closeMin % 60)
  } else if (minutes < 20 * 60) {
    state = 'post_market'
    nextOpen = nextOpenFrom(p.dateKey)
    nextClose = null
  } else {
    state = 'closed'
    nextOpen = nextOpenFrom(p.dateKey)
  }

  return {
    state,
    dateKey: p.dateKey,
    earlyClose: todayOpen && isEarlyClose(p.dateKey),
    nextOpen,
    nextClose,
    label: sessionLabel(state, nextOpen, nextClose),
  }
}

function sessionLabel(state: SessionState, nextOpen: Date | null, nextClose: Date | null): string {
  const etTime = (d: Date | null): string => {
    if (!d) return ''
    const p = etParts(d)
    const hh = String(p.hour).padStart(2, '0')
    const mm = String(p.minute).padStart(2, '0')
    return `${hh}:${mm} ET`
  }
  const dayName = (d: Date | null): string => {
    if (!d) return ''
    return ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][etParts(d).weekday]
  }
  switch (state) {
    case 'open':
      return nextClose ? `OPEN · CLOSES ${etTime(nextClose)}` : 'OPEN'
    case 'pre_market':
      return nextOpen ? `PRE-MARKET · OPENS ${etTime(nextOpen)}` : 'PRE-MARKET'
    case 'post_market':
      return nextOpen ? `POST-MARKET · OPENS ${dayName(nextOpen)} ${etTime(nextOpen)}` : 'POST-MARKET'
    default:
      return nextOpen ? `CLOSED · OPENS ${dayName(nextOpen)} ${etTime(nextOpen)}` : 'CLOSED'
  }
}

export function sessionState(at: Date): SessionState {
  return sessionInfo(at).state
}

export function isMarketOpen(at: Date): boolean {
  return sessionState(at) === 'open'
}

/** The exchange-local session date a moment belongs to. */
export function sessionDateKey(at: Date): string {
  return etParts(at).dateKey
}

/** Next holiday on or after `from`, with its published name. */
export function nextHoliday(from: Date): { date: string; name: string } | null {
  const today = etParts(from).dateKey
  const keys = Object.keys(HOLIDAY_NAMES).sort()
  for (const key of keys) {
    if (key >= today) return { date: key, name: HOLIDAY_NAMES[key] }
  }
  return null
}

/** The next `count` holidays strictly after today. */
export function upcomingHolidays(from: Date, count: number): Array<{ date: string; name: string }> {
  const today = etParts(from).dateKey
  return Object.keys(HOLIDAY_NAMES)
    .sort()
    .filter((key) => key > today)
    .slice(0, count)
    .map((date) => ({ date, name: HOLIDAY_NAMES[date] }))
}
