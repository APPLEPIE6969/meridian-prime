import { describe, expect, it } from 'vitest'
import {
  addBusinessDays,
  closeMinuteFor,
  etDateToUtc,
  etParts,
  isEarlyClose,
  isTradingDay,
  nextHoliday,
  nextTradingDay,
  sessionInfo,
  upcomingHolidays,
} from '@/lib/calendar'

const d = (iso: string) => new Date(iso)

describe('exchange-timezone parts', () => {
  it('maps a UTC instant to ET wall time', () => {
    // 2026-01-05 14:30 UTC == 09:30 EST
    const p = etParts(d('2026-01-05T14:30:00Z'))
    expect(p.dateKey).toBe('2026-01-05')
    expect(p.hour).toBe(9)
    expect(p.minute).toBe(30)
    expect(p.weekday).toBe(1)
  })

  it('handles DST correctly across the fall-back', () => {
    // 2026-10-30 13:30 UTC == 09:30 EDT (UTC-4)
    const before = etParts(d('2026-10-30T13:30:00Z'))
    expect([before.hour, before.dateKey]).toEqual([9, '2026-10-30'])
    // 2026-11-02 14:30 UTC == 09:30 EST (UTC-5) — after the Nov 1 transition
    const after = etParts(d('2026-11-02T14:30:00Z'))
    expect([after.hour, after.dateKey]).toEqual([9, '2026-11-02'])
  })

  it('round-trips wall time to the same instant', () => {
    const utc = etDateToUtc('2026-07-15', 9, 30)
    expect(etParts(utc)).toMatchObject({ dateKey: '2026-07-15', hour: 9, minute: 30 })
  })
})

describe('trading days and holidays', () => {
  it('rejects weekends and known holidays', () => {
    expect(isTradingDay('2026-01-05')).toBe(true) // Monday
    expect(isTradingDay('2026-01-03')).toBe(false) // Saturday
    expect(isTradingDay('2026-01-04')).toBe(false) // Sunday
    expect(isTradingDay('2026-01-01')).toBe(false) // New Year's Day
    expect(isTradingDay('2026-07-03')).toBe(false) // Independence Day observed (Jul 4 is a Saturday)
    expect(isTradingDay('2026-12-25')).toBe(false) // Christmas
  })

  it('knows the next trading day across weekends and holidays', () => {
    expect(nextTradingDay('2026-01-02')).toBe('2026-01-05') // Fri -> Mon
    expect(nextTradingDay('2026-07-02')).toBe('2026-07-06') // Thu, then observed holiday Fri + weekend
    expect(nextTradingDay('2026-11-25')).toBe('2026-11-27') // Wed before Thanksgiving? no: 26 is the holiday
  })

  it('walks business days in both directions', () => {
    expect(addBusinessDays('2026-01-05', 1)).toBe('2026-01-06')
    expect(addBusinessDays('2026-01-06', -1)).toBe('2026-01-05')
    // T+1 over a weekend: Friday settles Monday
    expect(addBusinessDays('2026-01-02', 1)).toBe('2026-01-05')
  })

  it('lists upcoming holidays after today', () => {
    const next = nextHoliday(d('2026-11-02T12:00:00Z'))
    expect(next).not.toBeNull()
    expect(next!.date).toBe('2026-11-26') // Thanksgiving 2026
    expect(next!.name).toContain('Thanksgiving')
    const list = upcomingHolidays(d('2026-11-02T12:00:00Z'), 3)
    expect(list.map((h) => h.date)).toEqual(['2026-11-26', '2026-12-25', '2027-01-01'])
  })

  it('flags published early closes', () => {
    expect(isEarlyClose('2026-11-27')).toBe(true) // day after Thanksgiving
    expect(isEarlyClose('2026-07-02')).toBe(true) // eve of the observed July 4
    expect(isEarlyClose('2026-12-24')).toBe(true)
    expect(closeMinuteFor('2026-11-27')).toBe(13 * 60)
    expect(closeMinuteFor('2026-11-30')).toBe(16 * 60)
  })
})

describe('session state', () => {
  it('is open during regular hours', () => {
    const info = sessionInfo(d('2026-01-05T15:00:00Z')) // 10:00 ET Monday
    expect(info.state).toBe('open')
    expect(info.label).toContain('OPEN')
    expect(info.nextClose).not.toBeNull()
  })

  it('is pre-market before the open', () => {
    const info = sessionInfo(d('2026-01-05T13:00:00Z')) // 08:00 ET
    expect(info.state).toBe('pre_market')
    expect(info.nextOpen).not.toBeNull()
    expect(etParts(info.nextOpen!).dateKey).toBe('2026-01-05')
  })

  it('is post-market after a regular close', () => {
    const info = sessionInfo(d('2026-01-05T22:00:00Z')) // 17:00 ET
    expect(info.state).toBe('post_market')
    expect(etParts(info.nextOpen!).dateKey).toBe('2026-01-06')
  })

  it('is closed on weekends with the next open on Monday', () => {
    const info = sessionInfo(d('2026-01-03T18:00:00Z')) // Saturday
    expect(info.state).toBe('closed')
    expect(etParts(info.nextOpen!).dateKey).toBe('2026-01-05')
    expect(info.label).toContain('MON')
  })

  it('is closed on holidays and skips to the next session', () => {
    // 2026-11-26 is Thanksgiving (Thursday)
    const info = sessionInfo(d('2026-11-26T15:00:00Z'))
    expect(info.state).toBe('closed')
    expect(etParts(info.nextOpen!).dateKey).toBe('2026-11-27')
  })

  it('reports early close sessions as open with a 13:00 close', () => {
    const info = sessionInfo(d('2026-11-27T17:00:00Z')) // 12:00 ET on the early close
    expect(info.state).toBe('open')
    expect(info.earlyClose).toBe(true)
    expect(etParts(info.nextClose!).hour).toBe(13)
  })
})
