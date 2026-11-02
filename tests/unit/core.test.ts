import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { now, realNow, resetClock, setClockOverride } from '@/lib/clock'
import { cfg } from '@/lib/config'
import { log } from '@/lib/log'
import { db, resetDb, resolveDatabaseUrl, setDb } from '@/lib/db'
import { projectRoot, repoPath, resetProjectRoot } from '@/lib/paths'
import { handleError, ok, fail } from '@/lib/api/respond'
import { OrderError } from '@/lib/engine/engine'

// ── clock ────────────────────────────────────────────────────────────────────

describe('platform clock', () => {
  const ORIGINAL = process.env.MERIDIAN_CLOCK

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MERIDIAN_CLOCK
    else process.env.MERIDIAN_CLOCK = ORIGINAL
    resetClock()
  })

  it('reads a frozen boot time from MERIDIAN_CLOCK', () => {
    process.env.MERIDIAN_CLOCK = '2026-03-09T14:30:00Z'
    resetClock()
    expect(now().toISOString()).toBe('2026-03-09T14:30:00.000Z')
  })

  it('ignores an unparsable MERIDIAN_CLOCK and keeps wall time', () => {
    process.env.MERIDIAN_CLOCK = 'not-a-timestamp'
    resetClock()
    expect(Math.abs(now().getTime() - realNow().getTime())).toBeLessThan(5_000)
  })

  it('applies offset shifts and honors explicit overrides', () => {
    setClockOverride({ offsetMs: 60_000 })
    const shifted = now().getTime() - realNow().getTime()
    expect(Math.abs(shifted - 60_000)).toBeLessThan(50)

    setClockOverride({ frozen: Date.parse('2026-01-05T14:30:00Z'), offsetMs: 0 })
    expect(now().toISOString()).toBe('2026-01-05T14:30:00.000Z')

    setClockOverride({ frozen: null })
    resetClock()
    expect(Math.abs(now().getTime() - realNow().getTime())).toBeLessThan(5_000)
  })

  it('clears everything on resetClock', () => {
    setClockOverride({ frozen: Date.parse('2026-01-05T14:30:00Z') })
    resetClock()
    expect(now().getTime()).not.toBe(Date.parse('2026-01-05T14:30:00Z'))
  })
})

// ── config ───────────────────────────────────────────────────────────────────

describe('config', () => {
  const KEYS = ['MERIDIAN_POLL_INTERVAL_MS', 'MERIDIAN_MINUTE_REFRESH']

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k]
  })

  afterEach(() => {
    for (const k of KEYS) delete process.env[k]
  })

  it('accepts positive integer overrides', () => {
    process.env.MERIDIAN_POLL_INTERVAL_MS = '2500'
    process.env.MERIDIAN_MINUTE_REFRESH = '3'
    expect(cfg().pollIntervalMs).toBe(2500)
    expect(cfg().minuteRefresh).toBe(3)
  })

  it('falls back on junk, zero and negative values', () => {
    process.env.MERIDIAN_POLL_INTERVAL_MS = 'abc'
    process.env.MERIDIAN_MINUTE_REFRESH = '-4'
    expect(cfg().pollIntervalMs).toBe(5000)
    expect(cfg().minuteRefresh).toBe(8)

    process.env.MERIDIAN_POLL_INTERVAL_MS = '0'
    process.env.MERIDIAN_MINUTE_REFRESH = '2.9'
    expect(cfg().pollIntervalMs).toBe(5000)
    expect(cfg().minuteRefresh).toBe(2) // finite + positive, floored
  })

  it('exposes the desk defaults', () => {
    expect(cfg().dataProvider).toBe('fixture') // set by tests/setup.ts
    expect(cfg().operatorPasscode.length).toBeGreaterThan(0)
    expect(cfg().relayToken.length).toBeGreaterThan(0)
  })
})

// ── log ──────────────────────────────────────────────────────────────────────

describe('structured logging', () => {
  const ORIGINAL = process.env.MERIDIAN_LOG_LEVEL

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MERIDIAN_LOG_LEVEL
    else process.env.MERIDIAN_LOG_LEVEL = ORIGINAL
    vi.restoreAllMocks()
  })

  it('routes levels to the right console channel and serializes meta', () => {
    process.env.MERIDIAN_LOG_LEVEL = 'debug'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    log('debug', 'dbg', { k: 1 })
    log('info', 'inf')
    log('warn', 'wrn', { k: 2 })
    log('error', 'err')

    expect(logSpy).toHaveBeenCalledTimes(2) // debug + info
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({ level: 'debug', msg: 'dbg', k: 1 })
    expect(JSON.parse(String(logSpy.mock.calls[1][0]))).toMatchObject({ level: 'info', msg: 'inf' })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledTimes(1)
  })

  it('suppresses levels below the configured floor', () => {
    process.env.MERIDIAN_LOG_LEVEL = 'error'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log('debug', 'hidden')
    log('info', 'hidden too')
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('falls back to info for an unknown configured level', () => {
    process.env.MERIDIAN_LOG_LEVEL = 'shouty'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log('debug', 'hidden at info floor')
    log('info', 'visible')
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(logSpy.mock.calls[0][0])).msg).toBe('visible')
  })
})

// ── respond envelope ─────────────────────────────────────────────────────────

describe('respond helpers', () => {
  it('wraps ok() and fail() payloads', async () => {
    const good = ok({ a: 1 }, 201, { 'x-extra': '1' })
    expect(good.status).toBe(201)
    expect(good.headers.get('x-extra')).toBe('1')
    expect(await good.json()).toEqual({ data: { a: 1 } })

    const bad = fail(418, 'teapot', 'short and stout', { hint: 'x' })
    expect(bad.status).toBe(418)
    expect(await bad.json()).toEqual({ error: { code: 'teapot', message: 'short and stout', hint: 'x' } })
  })

  it('passes structured OrderErrors through unchanged', async () => {
    const res = handleError(new OrderError('unknown_symbol', 'nope', 404))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'unknown_symbol', message: 'nope' } })
  })

  it('maps plain errors to a 500 without leaking internals', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = handleError(new Error('secret database detail'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: 'internal_error', message: 'Internal error' } })
    expect(errSpy).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('stringifies non-Error throwables and tolerates missing stacks', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = handleError('just a string')
    expect(res.status).toBe(500)
    expect(String(errSpy.mock.calls[0][0])).toContain('just a string')

    const stackless = new Error('no stack')
    delete stackless.stack
    const res2 = handleError(stackless)
    expect(res2.status).toBe(500)
    vi.restoreAllMocks()
  })
})

// ── db url resolution ────────────────────────────────────────────────────────

describe('database url resolution', () => {
  const ORIGINAL = process.env.DATABASE_URL

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = ORIGINAL
    resetDb()
  })

  it('passes non-file URLs through untouched', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@host/db'
    expect(resolveDatabaseUrl()).toBe('postgres://user:pass@host/db')
  })

  it('keeps absolute file URLs as-is', () => {
    process.env.DATABASE_URL = 'file:/abs/path/prime.db'
    expect(resolveDatabaseUrl()).toBe('file:/abs/path/prime.db')
  })

  it('roots relative file URLs at the project directory', () => {
    process.env.DATABASE_URL = 'file:./data/prime.db'
    const resolved = resolveDatabaseUrl()
    expect(resolved).toBe(`file:${path.join(process.cwd(), 'data/prime.db')}`)
    expect(resolved.startsWith('file:/')).toBe(true)
  })

  it('defaults to ./prime.db when DATABASE_URL is unset', () => {
    delete process.env.DATABASE_URL
    expect(resolveDatabaseUrl()).toBe(`file:${path.join(process.cwd(), 'prime.db')}`)
  })

  it('normalizes the env var when the singleton is first constructed', async () => {
    process.env.DATABASE_URL = `file:${path.join(process.cwd(), '.vitest.db')}`
    const client = db()
    expect(client).toBe(db()) // memoized singleton
    setDb(client)
    resetDb()
    expect(db()).not.toBe(client) // rebuilt after reset
  })

  it('rewrites a relative DATABASE_URL into an absolute one on first use', () => {
    process.env.DATABASE_URL = 'file:./.vitest.db'
    resetDb()
    try {
      db() // constructs the singleton, normalizing the env var in place
      expect(process.env.DATABASE_URL).toBe(`file:${path.join(process.cwd(), '.vitest.db')}`)
    } finally {
      resetDb()
    }
  })
})

// ── project root walker ──────────────────────────────────────────────────────

describe('project root resolution', () => {
  it('finds the repo root from the normal working directory', () => {
    expect(repoPath('package.json')).toBe(path.join(process.cwd(), 'package.json'))
    expect(fs.existsSync(repoPath('package.json'))).toBe(true)
  })

  it('walks up and falls back to cwd when no package.json exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-root-'))
    const deep = path.join(tmp, 'a', 'b', 'c')
    fs.mkdirSync(deep, { recursive: true })
    const cwd = process.cwd()
    process.chdir(deep)
    resetProjectRoot() // forget the cached root so the walker runs
    try {
      expect(projectRoot()).toBe(deep) // no package.json anywhere above → fallback
      expect(repoPath('x', 'y')).toBe(path.join(deep, 'x', 'y'))
    } finally {
      process.chdir(cwd)
      resetProjectRoot() // re-cache the real root for everyone else
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    expect(projectRoot()).toBe(cwd)
  })
})
