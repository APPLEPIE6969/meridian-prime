import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { relayPush } from '@/lib/relay'

// The relay push is fire-and-forget by design: it must never throw into the
// trading path, it must hit /internal/broadcast with the token header, and
// failures are logged at debug level and swallowed.

const ORIGINAL_URL = process.env.MERIDIAN_RELAY_URL
const ORIGINAL_TOKEN = process.env.MERIDIAN_RELAY_TOKEN

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

beforeEach(() => {
  process.env.MERIDIAN_RELAY_TOKEN = 'test-token'
})

afterEach(async () => {
  await flush()
  vi.unstubAllGlobals()
  if (ORIGINAL_URL === undefined) delete process.env.MERIDIAN_RELAY_URL
  else process.env.MERIDIAN_RELAY_URL = ORIGINAL_URL
  if (ORIGINAL_TOKEN === undefined) delete process.env.MERIDIAN_RELAY_TOKEN
  else process.env.MERIDIAN_RELAY_TOKEN = ORIGINAL_TOKEN
})

describe('relayPush()', () => {
  it('is a no-op when no relay URL is configured', async () => {
    delete process.env.MERIDIAN_RELAY_URL
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    relayPush('activity', { hello: 1 })
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the event to /internal/broadcast with the token header', async () => {
    process.env.MERIDIAN_RELAY_URL = 'http://127.0.0.1:9753'
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    relayPush('market', { quotes: [] })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:9753/internal/broadcast')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-relay-token': 'test-token' })
    expect(JSON.parse(String(init.body))).toEqual({ event: 'market', payload: { quotes: [] } })
  })

  it('strips a trailing slash from the configured URL', async () => {
    process.env.MERIDIAN_RELAY_URL = 'http://127.0.0.1:9753/'
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    relayPush('activity', {})
    await flush()
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('http://127.0.0.1:9753/internal/broadcast')
  })

  it('swallows and logs Error rejections at debug level', async () => {
    process.env.MERIDIAN_RELAY_URL = 'http://127.0.0.1:9753'
    process.env.MERIDIAN_LOG_LEVEL = 'debug' // failure logging is debug-level
    const errSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))
    expect(() => relayPush('activity', {})).not.toThrow()
    await flush()
    const lines = errSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('"relay push failed"') && l.includes('ECONNREFUSED'))).toBe(true)
    errSpy.mockRestore()
    process.env.MERIDIAN_LOG_LEVEL = 'warn'
  })

  it('stringifies non-Error rejections too', async () => {
    process.env.MERIDIAN_RELAY_URL = 'http://127.0.0.1:9753'
    process.env.MERIDIAN_LOG_LEVEL = 'debug'
    const errSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject('plain string failure')))
    relayPush('activity', {})
    await flush()
    const lines = errSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('plain string failure'))).toBe(true)
    errSpy.mockRestore()
    process.env.MERIDIAN_LOG_LEVEL = 'warn'
  })
})
