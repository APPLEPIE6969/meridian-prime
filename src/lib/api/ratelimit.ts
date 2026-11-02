// In-memory sliding-window rate limiter. Per API key for agent routes and
// per IP for public/console routes. 429s carry Retry-After.

interface Bucket {
  hits: number[]
}

const buckets = new Map<string, Bucket>()

export interface RateVerdict {
  ok: boolean
  remaining: number
  retryAfter: number
  limit: number
}

export function rateLimit(key: string, limit: number, windowMs: number): RateVerdict {
  const t = Date.now()
  const bucket = buckets.get(key) ?? { hits: [] }
  bucket.hits = bucket.hits.filter((hit) => t - hit < windowMs)
  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket)
    const oldest = bucket.hits[0]
    return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((windowMs - (t - oldest)) / 1000)), limit }
  }
  bucket.hits.push(t)
  buckets.set(key, bucket)
  return { ok: true, remaining: limit - bucket.hits.length, retryAfter: 0, limit }
}

export const AGENT_RATE_LIMIT = 120
export const AGENT_RATE_WINDOW_MS = 60_000
export const CONSOLE_RATE_LIMIT = 600
export const CONSOLE_RATE_WINDOW_MS = 60_000

export function resetRateLimits(): void {
  buckets.clear()
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'local'
}
