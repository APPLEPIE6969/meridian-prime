import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, desk } from '@/lib/client/api'

// The console's shared fetch helper: envelope unwrapping, error mapping and
// the 401 → /login redirect dance, driven against a stubbed fetch.

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('desk()', () => {
  it('unwraps the success envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { hello: 1 } }), { status: 200 })))
    const data = await desk<{ hello: number }>('/api/console/overview')
    expect(data).toEqual({ hello: 1 })
  })

  it('sends cookie credentials, no-store and a JSON content type', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await desk('/api/console/overview', { method: 'POST', headers: { 'x-custom': '1' } })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/console/overview')
    expect(init.credentials).toBe('same-origin')
    expect(init.cache).toBe('no-store')
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-custom': '1' })
  })

  it('maps non-2xx envelopes to ApiError with the server code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'name_taken', message: 'nope' } }), { status: 409 })))
    const err = await desk('/api/console/agents').catch((e: unknown) => e as ApiError)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect((err as ApiError).code).toBe('name_taken')
    expect((err as ApiError).message).toBe('nope')
  })

  it('falls back to generic error fields when the envelope is thin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{}}', { status: 500 })))
    const err = await desk('/x').catch((e: unknown) => e as ApiError)
    expect((err as ApiError).code).toBe('error')
    expect((err as ApiError).message).toBe('HTTP 500')
  })

  it('rejects malformed bodies as bad_response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    const err = await desk('/x').catch((e: unknown) => e as ApiError)
    expect((err as ApiError).code).toBe('bad_response')
    expect((err as ApiError).status).toBe(200)
  })

  it('redirects to /login on 401 when browsing another page', async () => {
    vi.stubGlobal('window', { location: { pathname: '/overview', href: 'http://x/overview' } })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(desk('/api/console/overview')).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect((window as unknown as { location: { href: string } }).location.href).toBe('/login')
  })

  it('does not redirect from the login page or the public clock endpoint', async () => {
    vi.stubGlobal('window', { location: { pathname: '/login', href: 'http://x/login' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{}}', { status: 401 })))
    await expect(desk('/api/console/login')).rejects.toMatchObject({ status: 401 })
    await expect(desk('/api/console/clock')).rejects.toMatchObject({ status: 401 })
    expect((window as unknown as { location: { href: string } }).location.href).toBe('http://x/login')
  })

  it('skips the window dance entirely outside the browser', async () => {
    // No window global at all (node): the 401 still throws, nothing crashes.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{}}', { status: 401 })))
    await expect(desk('/api/console/overview')).rejects.toMatchObject({ status: 401 })
  })
})

// ── console formatters (pure functions) ──────────────────────────────────────

import { clsFor, clockTime, compact, dayTime, pct, signedPct, signedUsd, timeAgo, usd } from '@/lib/client/format'

describe('console formatters', () => {
  it('formats USD with an em-dash for missing values', () => {
    expect(usd(1234.56)).toBe('$1,234.56')
    expect(usd(0)).toBe('$0.00')
    expect(usd(-12.5)).toBe('-$12.50')
    expect(usd(1.005, 4)).toBe('$1.0050')
    expect(usd(null)).toBe('—')
    expect(usd(undefined)).toBe('—')
    expect(usd(Number.NaN)).toBe('—')
    expect(usd(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('signs positive USD values only', () => {
    expect(signedUsd(1234.56)).toBe('+$1,234.56')
    expect(signedUsd(-1234.56)).toBe('-$1,234.56')
    expect(signedUsd(0)).toBe('$0.00')
    expect(signedUsd(null)).toBe('—')
  })

  it('formats fractions as percentages', () => {
    expect(pct(0.1234)).toBe('+12.34%')
    expect(pct(-0.0321)).toBe('-3.21%')
    expect(pct(0)).toBe('0.00%') // 0 is not > 0 — unsigned
    expect(pct(null)).toBe('—')
    expect(pct(undefined)).toBe('—')
    expect(pct(Number.NaN)).toBe('—')
  })

  it('formats already-percent values without scaling', () => {
    expect(signedPct(1.23)).toBe('+1.23%')
    expect(signedPct(-1.23)).toBe('-1.23%')
    expect(signedPct(0)).toBe('0.00%') // 0 is not > 0 — unsigned
    expect(signedPct(null)).toBe('—')
    expect(signedPct(Number.NaN)).toBe('—')
  })

  it('compacts large numbers', () => {
    expect(compact(1_500_000)).toBe('1.5M')
    expect(compact(42_000)).toBe('42K')
    expect(compact(null)).toBe('—')
    expect(compact(undefined)).toBe('—')
    expect(compact(Number.NaN)).toBe('—')
  })

  it('renders relative ages', () => {
    const nowMs = Date.now()
    expect(timeAgo(new Date(nowMs - 5_000).toISOString())).toBe('5s')
    expect(timeAgo(new Date(nowMs - 3 * 60_000).toISOString())).toBe('3m')
    expect(timeAgo(new Date(nowMs - 5 * 3_600_000).toISOString())).toBe('5h')
    expect(timeAgo(new Date(nowMs - 3 * 86_400_000).toISOString())).toBe('3d')
    expect(timeAgo(new Date(nowMs + 60_000).toISOString())).toBe('0s') // future clamps
    expect(timeAgo('garbage')).toBe('')
  })

  it('renders wall-clock and day timestamps, or empty on junk', () => {
    expect(clockTime('2026-01-05T14:30:00Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(clockTime('garbage')).toBe('')
    expect(dayTime('2026-01-05T14:30:00Z')).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/)
    expect(dayTime('garbage')).toBe('')
  })

  it('picks the sentiment class', () => {
    expect(clsFor(1)).toBe('pos')
    expect(clsFor(-1)).toBe('neg')
    expect(clsFor(0)).toBe('muted')
  })
})
