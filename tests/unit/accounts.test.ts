import { afterEach, describe, expect, it } from 'vitest'
import { createAgent, findAccountByKey, hashKey, isPdtRestricted, marginRequirement, dayTradeWindowStart } from '@/lib/engine/accounts'
import { db } from '@/lib/db'
import { etParts } from '@/lib/calendar'

async function cleanup(name: string): Promise<void> {
  const account = await db().account.findUnique({ where: { name } })
  if (account) await db().account.delete({ where: { id: account.id } })
}

describe('agent provisioning', () => {
  const name = `metrics-${Date.now()}`

  afterEach(async () => {
    await cleanup(name)
    await cleanup(`${name}-2`)
  })

  it('creates an account with a deposit and a one-time API key', async () => {
    const creds = await createAgent(name, { startingCash: 250_000, kind: 'margin' })
    expect(creds.apiKey).toMatch(/^mrp_live_[0-9a-f]{48}$/)
    expect(creds.startingCash).toBe(250_000)

    const account = await findAccountByKey(creds.apiKey)
    expect(account).not.toBeNull()
    expect(account!.keyHash).toBe(hashKey(creds.apiKey))
    expect(account!.keyPreview).toContain('…')

    const ledger = await db().cashLedger.findFirst({ where: { accountId: account!.id } })
    expect(ledger?.amount).toBe(250_000)
    expect(ledger?.settled).toBe(true)

    // The key resolves; garbage does not.
    expect(await findAccountByKey('mrp_live_deadbeef')).toBeNull()
  })

  it('defaults to a margin account with the standard base', async () => {
    const creds = await createAgent(`${name}-2`)
    expect(creds.kind).toBe('margin')
    expect(creds.startingCash).toBe(1_000_000)
  })
})

describe('margin requirements', () => {
  it('is 50% initial on gross exposure', () => {
    const req = marginRequirement(100_000, 0)
    expect(req.initial).toBe(50_000)
    expect(req.maintenance).toBe(25_000)
  })

  it('weights short maintenance higher than long', () => {
    const req = marginRequirement(0, 100_000)
    expect(req.maintenance).toBe(30_000)
    const mixed = marginRequirement(200_000, 100_000)
    expect(mixed.maintenance).toBe(25_000 * 2 + 30_000)
  })
})

describe('PDT state', () => {
  it('restricts sub-$25k margin accounts out of day trades', () => {
    const restricted = {
      kind: 'margin',
      equity: 10_000,
      dayTradesRemaining: 0,
    } as never
    expect(isPdtRestricted(restricted)).toBe(true)

    const wealthy = { kind: 'margin', equity: 100_000, dayTradesRemaining: 0 } as never
    expect(isPdtRestricted(wealthy)).toBe(false)

    const cashAccount = { kind: 'cash', equity: 1_000, dayTradesRemaining: 0 } as never
    expect(isPdtRestricted(cashAccount)).toBe(false)

    const withTradesLeft = { kind: 'margin', equity: 10_000, dayTradesRemaining: 2 } as never
    expect(isPdtRestricted(withTradesLeft)).toBe(false)
  })
})

describe('day trade window', () => {
  it('spans the last five business days', () => {
    const start = dayTradeWindowStart(new Date('2026-01-05T15:00:00Z')) // Monday
    const parts = etParts(start)
    expect(parts.dateKey).toBe('2025-12-29') // Mon - 4 business days
    expect(parts.hour).toBe(0)
  })
})
