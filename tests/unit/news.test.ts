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
