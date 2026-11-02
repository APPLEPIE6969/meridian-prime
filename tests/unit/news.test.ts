import { beforeEach, describe, expect, it } from 'vitest'
import { NewsWire, resetNewsWire } from '@/lib/market/news'
import { db } from '@/lib/db'

beforeEach(async () => {
  resetNewsWire()
  await db().newsItem.deleteMany()
})

describe('news wire', () => {
  it('persists headlines from the provider', async () => {
    const wire = new NewsWire()
    const stored = await wire.refresh(['AAPL'])
    expect(stored).toBeGreaterThan(0)
    const rows = await wire.latest({ limit: 50 })
    expect(rows.length).toBe(stored)
    for (const row of rows) {
      expect(row.headline.length).toBeGreaterThan(5)
      expect(row.symbols).toContain('AAPL')
      expect(row.url).toMatch(/^https:\/\//)
    }
  })

  it('merges symbol tags when the same headline arrives from another feed', async () => {
    const wire = new NewsWire()
    await wire.refresh(['AAPL'])
    const first = await wire.latest({ limit: 1 })
    const providerId = first[0].providerId
    const afterFirst = await db().newsItem.count()
    expect(afterFirst).toBeGreaterThan(0)

    // A second identical pass must not duplicate anything.
    await wire.refresh(['AAPL'])
    expect(await db().newsItem.count()).toBe(afterFirst)

    // The upsert path merges symbol tags rather than overwriting them.
    await db().newsItem.update({ where: { providerId }, data: { symbols: JSON.stringify(['AAPL', 'MSFT']) } })
    const merged = await wire.latest({ symbols: ['MSFT'] })
    expect(merged.length).toBe(1)
    expect(merged[0].symbols.sort()).toEqual(['AAPL', 'MSFT'])
  })

  it('filters by symbol and honors the limit', async () => {
    const wire = new NewsWire()
    await wire.refresh(['AAPL'])
    expect((await wire.latest({ symbols: ['TSLA'] })).length).toBe(0)
    expect((await wire.latest({ symbols: ['AAPL'], limit: 2 })).length).toBeLessThanOrEqual(2)
  })

  it('records refresh health', async () => {
    const wire = new NewsWire()
    expect(wire.lastRefreshAt).toBe(0)
    await wire.refresh(['AAPL'])
    expect(wire.lastRefreshAt).toBeGreaterThan(0)
    expect(wire.lastError).toBeNull()
  })
})

// ── extended branches (100% coverage pass) ───────────────────────────────────

import { afterEach, vi } from 'vitest'
import { fixtureProvider } from '@/lib/provider/fixture'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('news wire extended branches', () => {
  it('walks the round-robin universe batch when no symbols are passed', async () => {
    const wire = new NewsWire()
    const stored = await wire.refresh() // nextBatch(): first 8 universe symbols
    expect(stored).toBeGreaterThan(0) // the batch includes AAPL's recorded feed
    expect(wire.lastError).toBeNull()
  })

  it('records provider failures of every shape and keeps serving', async () => {
    const wire = new NewsWire()
    const spy = vi.spyOn(fixtureProvider, 'getNews')
      .mockRejectedValueOnce(new Error('feed down'))
      .mockRejectedValueOnce('raw failure')
    expect(await wire.refresh(['AAPL'])).toBe(0)
    expect(wire.lastError).toBe('feed down')
    expect(await wire.refresh(['AAPL'])).toBe(0)
    expect(wire.lastError).toBe('raw failure')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('serializes concurrent refreshes behind the busy flag', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(fixtureProvider, 'getNews').mockReturnValue(gate.then(() => []))
    const wire = new NewsWire()
    const first = wire.refresh(['AAPL'])
    expect(await wire.refresh(['AAPL'])).toBe(0) // busy
    release()
    await first
    expect(wire.lastRefreshAt).toBeGreaterThan(0)
  })

  it('start/stop manage the refresh timer and the immediate first pull', async () => {
    const wire = new NewsWire()
    wire.start()
    wire.start() // timer already set
    await vi.waitFor(() => expect(wire.lastRefreshAt).toBeGreaterThan(0)) // the immediate refresh lands
    wire.stop()
    wire.stop() // idempotent, even without a timer
    const stopped = new NewsWire()
    stopped.stop() // no timer at all
  })

  it('clamps the latest() limit into a sane window', async () => {
    const wire = new NewsWire()
    await wire.refresh(['AAPL'])
    expect((await wire.latest({ limit: 0 })).length).toBeLessThanOrEqual(1)
    expect((await wire.latest({ limit: 99_999 })).length).toBeLessThanOrEqual(100)
  })

  it('tolerates malformed symbol tags and missing summaries', async () => {
    const wire = new NewsWire()
    await db().newsItem.create({
      data: { providerId: 'x1', headline: 'Object tags', source: 'T', url: 'https://x/1', symbols: JSON.stringify({ nope: true }), summary: 's', publishedAt: new Date() },
    })
    await db().newsItem.create({
      data: { providerId: 'x2', headline: 'Broken tags', source: 'T', url: 'https://x/2', symbols: '{invalid json', summary: null as unknown as string, publishedAt: new Date() },
    })
    const rows = await wire.latest({ limit: 50 })
    const byId = new Map(rows.map((r) => [r.providerId, r]))
    expect(byId.get('x1')!.symbols).toEqual([]) // non-array → []
    expect(byId.get('x2')!.symbols).toEqual([]) // unparseable → []
    expect(byId.get('x2')!.summary).toBe('') // null summary → ''
  })
})

describe('news wire failure unwind', () => {
  it('releases the busy flag even when the failure path itself explodes', async () => {
    const wire = new NewsWire()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console down')
    })
    const feedSpy = vi.spyOn(fixtureProvider, 'getNews').mockRejectedValue(new Error('feed down'))
    // The catch logs via console.warn, which throws — the error escapes the
    // catch and propagates through the finally, which must still release busy.
    await expect(wire.refresh(['AAPL'])).rejects.toThrow('console down')
    expect(wire.busyHealth()).toBe(false)

    warnSpy.mockRestore()
    feedSpy.mockRestore()
    expect(await wire.refresh(['AAPL'])).toBeGreaterThan(0) // not stuck busy
  })
})

describe('news wire latch failure', () => {
  it('propagates a jammed busy latch through the release path', async () => {
    const wire = new NewsWire()
    const jammed = new Proxy(wire, {
      set(target, prop, value, receiver) {
        if (prop === 'busy' && value === false) throw new Error('latch jammed')
        return Reflect.set(target, prop, value, receiver)
      },
    })
    // The refresh succeeds; the finally's release throws — the error must
    // win over the return value.
    await expect(jammed.refresh(['AAPL'])).rejects.toThrow('latch jammed')

    // Same jam on the failure path: the catch's `return 0` loses to the
    // release throw as well. (The first jam left the latch stuck — the trap
    // threw before the reset landed — so release it directly.)
    Reflect.set(wire, 'busy', false)
    vi.spyOn(fixtureProvider, 'getNews').mockRejectedValue(new Error('feed down'))
    await expect(jammed.refresh(['AAPL'])).rejects.toThrow('latch jammed')
  })
})
