import { describe, expect, it, beforeEach } from 'vitest'
import { rateLimit, resetRateLimits, clientIp } from '@/lib/api/ratelimit'

beforeEach(() => {
  resetRateLimits()
})

describe('sliding-window rate limiter', () => {
  it('admits requests under the limit and reports remaining budget', () => {
    for (let i = 0; i < 5; i++) {
      const verdict = rateLimit('k', 5, 60_000)
      expect(verdict.ok).toBe(true)
      expect(verdict.remaining).toBe(4 - i)
    }
  })

  it('blocks over the limit with a retry-after', () => {
    for (let i = 0; i < 5; i++) rateLimit('k', 5, 60_000)
    const blocked = rateLimit('k', 5, 60_000)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfter).toBeGreaterThan(0)
    expect(blocked.retryAfter).toBeLessThanOrEqual(60)
  })

  it('tracks keys independently', () => {
    for (let i = 0; i < 5; i++) rateLimit('a', 5, 60_000)
    expect(rateLimit('a', 5, 60_000).ok).toBe(false)
    expect(rateLimit('b', 5, 60_000).ok).toBe(true)
  })

  it('expires old hits outside the window', () => {
    // Drive the window with a tiny window and real time (2ms).
    expect(rateLimit('w', 1, 2).ok).toBe(true)
    expect(rateLimit('w', 1, 2).ok).toBe(false)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(rateLimit('w', 1, 2).ok).toBe(true)
        resolve()
      }, 5)
    })
  })

  it('derives the client ip from proxy headers', () => {
    const req = new Request('http://x/', { headers: { 'x-forwarded-for': '10.1.2.3, 10.0.0.1' } })
    expect(clientIp(req)).toBe('10.1.2.3')
    expect(clientIp(new Request('http://x/', { headers: { 'x-real-ip': '10.9.9.9' } }))).toBe('10.9.9.9')
    expect(clientIp(new Request('http://x/'))).toBe('local')
  })
})
