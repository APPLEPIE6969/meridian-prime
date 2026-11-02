import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClock, setClockOverride } from '@/lib/clock'
import { createAgent } from '@/lib/engine/accounts'
import { resetTradingEngine, tradingEngine } from '@/lib/engine/engine'
import { quoteService, resetQuoteService } from '@/lib/market/quotes'
import { newsWire, resetNewsWire } from '@/lib/market/news'
import { candleCache, resetCandleCache } from '@/lib/market/candles'
import { db, setDb } from '@/lib/db'
import type { PrismaClient } from '@prisma/client'
import { resetRateLimits, rateLimit, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS, CONSOLE_RATE_LIMIT, CONSOLE_RATE_WINDOW_MS } from '@/lib/api/ratelimit'
import * as ratelimitModule from '@/lib/api/ratelimit'
import { cfg } from '@/lib/config'

import { GET as statusGET } from '@/app/api/v1/market/status/route'
import { GET as calendarGET } from '@/app/api/v1/market/calendar/route'
import { GET as newsGET } from '@/app/api/v1/market/news/route'
import { GET as candlesGET } from '@/app/api/v1/market/candles/route'
import { GET as stocksGET } from '@/app/api/v1/market/stocks/route'
import { GET as stockGET } from '@/app/api/v1/market/stocks/[symbol]/route'
import { GET as positionGET } from '@/app/api/v1/positions/[symbol]/route'
import { GET as activitiesGET } from '@/app/api/v1/account/activities/route'
import { GET as historyGET } from '@/app/api/v1/account/portfolio/history/route'
import { GET as orderGET, DELETE as orderDELETE } from '@/app/api/v1/orders/[id]/route'
import { GET as consoleCandlesGET } from '@/app/api/console/candles/route'
import { GET as consoleQuoteGET } from '@/app/api/console/quote/route'
import { GET as consoleNewsGET } from '@/app/api/console/news-wire/route'
import { GET as consoleClockGET } from '@/app/api/console/clock/route'
import { GET as overviewGET } from '@/app/api/console/overview/route'
import { GET as agentsGET, POST as agentsPOST } from '@/app/api/console/agents/route'
import { GET as agentDetailGET } from '@/app/api/console/agents/[id]/route'
import { POST as loginPOST } from '@/app/api/console/login/route'

// Edge branches for the HTTP surface: the catch-all handlers, rate-limit
// rejections, parameter clamps and the null-side optional chains. The happy
// paths live in routes.test.ts.

const OPEN = Date.parse('2026-01-05T14:30:00Z') // Monday 09:30 ET
const CLOSED_SUNDAY = Date.parse('2026-01-04T18:00:00Z') // Sunday 13:00 ET
const EARLY_CLOSE_NOON = Date.parse('2026-07-02T16:00:00Z') // Jul 2 2026, 12:00 ET (early-close day)

function agentHeaders(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` }
}

function jsonBody(method: string, url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

async function status(res: Response): Promise<number> {
  return res.status
}

async function data(res: Response): Promise<Record<string, unknown>> {
  expect(res.status).toBeLessThan(500)
  return (await res.json()).data
}

function fillBucket(key: string, limit: number, windowMs: number): void {
  for (let i = 0; i < limit; i++) rateLimit(key, limit, windowMs)
}

/**
 * Swap the process-wide Prisma client for a stub that throws on demand.
 * Prisma delegates cannot be spied (the spy poisons the delegate for the rest
 * of the shared-fork run), so database-level failures are injected through
 * the platform's own setDb() seam instead. Pass-through methods keep working.
 */
function withBrokenDb(stubs: Record<string, Record<string, (args: unknown) => unknown>>, fn: () => Promise<unknown>): Promise<unknown> {
  const real = db()
  const shell: Record<string, unknown> = {}
  for (const [model, methods] of Object.entries(stubs)) {
    const delegate: Record<string, unknown> = {}
    for (const [method, impl] of Object.entries(methods)) {
      delegate[method] = impl
    }
    shell[model] = delegate
  }
  setDb(shell as unknown as PrismaClient)
  return fn().finally(() => setDb(real))
}

async function wipe(): Promise<void> {
  await db().fill.deleteMany()
  await db().order.deleteMany()
  await db().position.deleteMany()
  await db().cashLedger.deleteMany()
  await db().equitySnapshot.deleteMany()
  await db().dayTrade.deleteMany()
  await db().activity.deleteMany()
  await db().account.deleteMany()
  await db().newsItem.deleteMany()
}

beforeEach(async () => {
  resetRateLimits()
  resetQuoteService()
  resetTradingEngine()
  resetNewsWire()
  resetCandleCache()
  resetClock()
  setClockOverride({ frozen: OPEN })
  tradingEngine().wireMarketFeed()
  await quoteService().injectQuote('AAPL', { last: 250, bid: 249.99, ask: 250.01, prevClose: 248, dayVolume: 5_000_000 })
  await quoteService().injectQuote('KO', { last: 60, bid: 59.99, ask: 60.01, prevClose: 60, dayVolume: 8_000_000 })
  await wipe()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetClock()
  resetQuoteService()
  resetTradingEngine()
  resetNewsWire()
  resetCandleCache()
})

describe('closed-session optional chains', () => {
  it('populates nextOpen/nextClose when the desk is closed on a weekend', async () => {
    setClockOverride({ frozen: CLOSED_SUNDAY })
    await quoteService().pollOnce() // give the desk a poll timestamp

    const status = await data(await statusGET())
    expect((status.marketData as Record<string, unknown>).lastPollAt).not.toBeNull()
    expect((status.session as Record<string, unknown>).state).toBe('closed')
    expect((status.session as Record<string, unknown>).nextOpen).not.toBeNull()

    const clock = await data(await consoleClockGET())
    expect((clock.session as Record<string, unknown>).nextOpen).not.toBeNull()
    expect((clock.session as Record<string, unknown>).nextClose).toBeNull()

    const cal = await data(await calendarGET())
    expect((cal.today as Record<string, unknown>).tradingDay).toBe(false)
    expect((cal.today as Record<string, unknown>).regularHours).toBeNull()
  })

  it('marks early-close sessions with the 13:00 close', async () => {
    setClockOverride({ frozen: EARLY_CLOSE_NOON })
    const cal = await data(await calendarGET())
    const today = cal.today as Record<string, unknown>
    expect(today.earlyClose).toBe(true)
    expect(today.regularHours).toEqual({ open: '09:30', close: '13:00' })
    expect((cal.regularSchedule as Record<string, unknown>).earlyCloseTime).toBe('13:00')
  })
})

describe('v1 route guards and clamps', () => {
  it('rate-limits candles, news, stocks and instrument detail per key', async () => {
    const creds = await createAgent(`edge-rl-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    fillBucket(`candles:${creds.accountId}`, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS)
    expect(await status(await candlesGET(new Request('http://x/api/v1/market/candles?symbol=AAPL', { headers })))).toBe(429)

    fillBucket(`news:${creds.accountId}`, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS)
    expect(await status(await newsGET(new Request('http://x/api/v1/market/news', { headers })))).toBe(429)

    fillBucket(`stocks:${creds.accountId}`, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS)
    expect(await status(await stocksGET(new Request('http://x/api/v1/market/stocks', { headers })))).toBe(429)

    fillBucket(`stock:${creds.accountId}`, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS)
    expect(await status(await stockGET(new Request('http://x/api/v1/market/stocks/AAPL', { headers }), { params: Promise.resolve({ symbol: 'AAPL' }) }))).toBe(429)
  })

  it('validates candles parameters', async () => {
    const creds = await createAgent(`edge-cdl-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)
    const missing = await candlesGET(new Request('http://x/api/v1/market/candles', { headers }))
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('missing_symbol')
  })

  it('serves the news wire to agents with symbol and limit handling', async () => {
    const creds = await createAgent(`edge-news-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    const empty = await data(await newsGET(new Request('http://x/api/v1/market/news', { headers })))
    expect(empty.count).toBe(0)

    const filtered = await data(await newsGET(new Request('http://x/api/v1/market/news?symbol=AAPL,ZZZZ&limit=5', { headers })))
    expect(filtered.count).toBe(0)

    const junkLimit = await data(await newsGET(new Request('http://x/api/v1/market/news?limit=not-a-number', { headers })))
    expect(junkLimit.count).toBe(0)

    // A stored headline flows back out, filtered by symbol.
    await db().newsItem.create({
      data: { providerId: 'p1', headline: 'Hello', source: 'Test', url: 'https://x/1', symbols: JSON.stringify(['AAPL']), summary: null as unknown as string, publishedAt: new Date() },
    })
    const wire = await data(await newsGET(new Request('http://x/api/v1/market/news?symbol=aapl', { headers })))
    expect(wire.count).toBe(1)
    const headline = (wire.headlines as Array<Record<string, unknown>>)[0]
    expect(headline.summary).toBe('') // null summary → ''
    expect(headline.symbols).toEqual(['AAPL'])
  })

  it('surfaces instruments without quotes and handles a zero prevClose', async () => {
    const creds = await createAgent(`edge-stk-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    const all = await data(await stocksGET(new Request('http://x/api/v1/market/stocks', { headers })))
    const rows = all.instruments as Array<Record<string, unknown>>
    const aapl = rows.find((r) => r.symbol === 'AAPL') as Record<string, unknown>
    expect(aapl.quote).not.toBeNull() // quoted instrument
    const msft = rows.find((r) => r.symbol === 'MSFT') as Record<string, unknown>
    expect(msft.quote).toBeNull() // not injected → null quote

    await quoteService().injectQuote('KO', { prevClose: 0 }) // degenerate quote
    const after = await data(await stocksGET(new Request('http://x/api/v1/market/stocks?symbol=KO', { headers })))
    const koRow = (after.instruments as Array<Record<string, unknown>>).find((r) => r.symbol === 'KO') as Record<string, unknown>
    const quote = koRow.quote as Record<string, number | null>
    expect(quote.changePct).toBeNull() // prevClose 0 → percentage suppressed
  })

  it('handles instrument detail with broken history and unknown params', async () => {
    const creds = await createAgent(`edge-det-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    const histSpy = vi.spyOn(candleCache(), 'dailyHistory').mockRejectedValue(new Error('history down'))
    const detail = await data(await stockGET(new Request('http://x/api/v1/market/stocks/AAPL', { headers }), { params: Promise.resolve({ symbol: 'AAPL' }) }))
    expect(detail.quote).not.toBeNull()
    expect(detail.range52w).toEqual({ high: null, low: null }) // inner catch swallowed it
    histSpy.mockRestore()

    const emptySpy = vi.spyOn(candleCache(), 'dailyHistory').mockResolvedValue([])
    const empty = await data(await stockGET(new Request('http://x/api/v1/market/stocks/AAPL', { headers }), { params: Promise.resolve({ symbol: 'AAPL' }) }))
    expect(empty.range52w).toEqual({ high: null, low: null })
    emptySpy.mockRestore()
  })

  it('falls back to avgPrice when no market price exists for a position', async () => {
    const creds = await createAgent(`edge-pos-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)
    await db().position.create({ data: { accountId: creds.accountId, symbol: 'MSFT', qty: 5, avgPrice: 420 } })

    const priceSpy = vi.spyOn(tradingEngine(), 'priceOf').mockReturnValue(null)
    const row = await data(await positionGET(new Request('http://x/api/v1/positions/MSFT', { headers }), { params: Promise.resolve({ symbol: 'MSFT' }) }))
    expect(row.last).toBe(420) // priceOf null → avgPrice fallback
    priceSpy.mockRestore()

    const unknown = await positionGET(new Request('http://x/api/v1/positions/ZZZZ', { headers }), { params: Promise.resolve({ symbol: 'ZZZZ' }) })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('unknown_symbol')
  })

  it('clamps activity and history limits and filters orders', async () => {
    const creds = await createAgent(`edge-clamp-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    const activities = await data(await activitiesGET(new Request('http://x/api/v1/account/activities?limit=9999', { headers })))
    expect(activities.count).toBeGreaterThanOrEqual(0)

    const junk = await data(await activitiesGET(new Request('http://x/api/v1/account/activities?limit=0', { headers })))
    expect(junk.count).toBeGreaterThanOrEqual(0)

    const history = await data(await historyGET(new Request('http://x/api/v1/account/portfolio/history?limit=abc', { headers })))
    expect((history.points as unknown[]).length).toBeGreaterThanOrEqual(0)

    // Orders with every filter combination.
    await tradingEngine().placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 })
    const withFilters = await data(await (await import('@/app/api/v1/orders/route')).GET(new Request('http://x/api/v1/orders?status=filled&symbol=aapl&limit=abc', { headers })))
    expect((withFilters.orders as unknown[]).length).toBe(1)
    const bare = await data(await (await import('@/app/api/v1/orders/route')).GET(new Request('http://x/api/v1/orders', { headers })))
    expect(bare.count).toBe(1)
  })

  it('rejects order deletion of unknown and foreign orders', async () => {
    const creds = await createAgent(`edge-del-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    const delUnknown = await orderDELETE(new Request('http://x/api/v1/orders', { method: 'DELETE', headers }), { params: Promise.resolve({ id: 'nope' }) })
    expect(delUnknown.status).toBe(404)

    const foreign = await createAgent(`edge-foreign-${Date.now()}`)
    const order = await tradingEngine().placeOrder(foreign.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 })
    const delForeign = await orderDELETE(new Request('http://x/api/v1/orders', { method: 'DELETE', headers }), { params: Promise.resolve({ id: order.id }) })
    expect(delForeign.status).toBe(404)

    const getUnknown = await orderGET(new Request('http://x/api/v1/orders', { headers }), { params: Promise.resolve({ id: 'nope' }) })
    expect(getUnknown.status).toBe(404)
  })
})

describe('route catch-all handlers', () => {
  it('converts downstream failures into 500 envelopes on every v1 route', async () => {
    const creds = await createAgent(`edge-catch-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)
    const boom = new Error('boom')

    const metricsSpy = vi.spyOn(tradingEngine(), 'metrics').mockRejectedValueOnce(boom)
    expect(await status(await (await import('@/app/api/v1/account/route')).GET(new Request('http://x/api/v1/account', { headers })))).toBe(500)
    metricsSpy.mockRestore()

    // Database-level failures go through the setDb seam (see withBrokenDb).
    await withBrokenDb({ activity: { findMany: () => Promise.reject(boom) } }, async () => {
      expect(await status(await activitiesGET(new Request('http://x/api/v1/account/activities', { headers })))).toBe(500)
    })

    await withBrokenDb({ position: { findMany: () => Promise.reject(boom) } }, async () => {
      expect(await status(await (await import('@/app/api/v1/account/portfolio/route')).GET(new Request('http://x/api/v1/account/portfolio', { headers })))).toBe(500)
      expect(await status(await (await import('@/app/api/v1/positions/route')).GET(new Request('http://x/api/v1/positions', { headers })))).toBe(500)
    })

    await withBrokenDb({ equitySnapshot: { findMany: () => Promise.reject(boom) } }, async () => {
      expect(await status(await historyGET(new Request('http://x/api/v1/account/portfolio/history', { headers })))).toBe(500)
    })

    const quoteSpy = vi.spyOn(quoteService(), 'getQuote').mockImplementationOnce(() => {
      throw boom
    })
    expect(await status(await (await import('@/app/api/v1/market/quote/route')).GET(new Request('http://x/api/v1/market/quote?symbol=AAPL', { headers })))).toBe(500)
    quoteSpy.mockRestore()

    const stocksQuoteSpy = vi.spyOn(quoteService(), 'getQuote').mockImplementation(() => {
      throw boom
    })
    expect(await status(await stocksGET(new Request('http://x/api/v1/market/stocks', { headers })))).toBe(500)
    stocksQuoteSpy.mockRestore()

    const candleSpy = vi.spyOn(candleCache(), 'dailyHistory').mockRejectedValueOnce(boom)
    expect(await status(await candlesGET(new Request('http://x/api/v1/market/candles?symbol=AAPL', { headers })))).toBe(500)
    candleSpy.mockRestore()

    const newsSpy = vi.spyOn(newsWire(), 'latest').mockRejectedValueOnce(boom)
    expect(await status(await newsGET(new Request('http://x/api/v1/market/news', { headers })))).toBe(500)
    newsSpy.mockRestore()

    const listSpy = vi.spyOn(tradingEngine(), 'listOrders').mockRejectedValueOnce(boom)
    expect(await status(await (await import('@/app/api/v1/orders/route')).GET(new Request('http://x/api/v1/orders', { headers })))).toBe(500)
    listSpy.mockRestore()

    const placeSpy = vi.spyOn(tradingEngine(), 'placeOrder').mockRejectedValueOnce(boom)
    expect(await status(await (await import('@/app/api/v1/orders/route')).POST(jsonBody('POST', 'http://x/api/v1/orders', { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 }, headers)))).toBe(500)
    placeSpy.mockRestore()

    const getSpy = vi.spyOn(tradingEngine(), 'getOrder').mockRejectedValueOnce(boom)
    expect(await status(await orderGET(new Request('http://x/api/v1/orders', { headers }), { params: Promise.resolve({ id: 'x' }) }))).toBe(500)
    getSpy.mockRestore()

    const cancelSpy = vi.spyOn(tradingEngine(), 'cancelOrder').mockRejectedValueOnce(boom)
    expect(await status(await orderDELETE(new Request('http://x/api/v1/orders', { method: 'DELETE', headers }), { params: Promise.resolve({ id: 'x' }) }))).toBe(500)
    cancelSpy.mockRestore()

    // Rejected ctx.params also lands in the catch-all. The rejection is
    // pre-marked handled so Node does not flag it before the route awaits it.
    const boomParams = (): Promise<{ symbol: string }> => {
      const p = Promise.reject(boom)
      p.catch(() => {})
      return p
    }
    expect(await status(await stockGET(new Request('http://x/api/v1/market/stocks/AAPL', { headers }), { params: boomParams() }))).toBe(500)
    expect(await status(await positionGET(new Request('http://x/api/v1/positions/AAPL', { headers }), { params: boomParams() }))).toBe(500)
  })

  it('converts downstream failures into 500 envelopes on console routes', async () => {
    const ok = await loginPOST(jsonBody('POST', 'http://x/api/console/login', { passcode: cfg().operatorPasscode }))
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0]
    const headers = { cookie }
    const boom = new Error('boom')

    await withBrokenDb({ account: { findMany: () => Promise.reject(boom) } }, async () => {
      expect(await status(await agentsGET(new Request('http://x/api/console/agents', { headers })))).toBe(500)
    })

    // The duplicate-name lookup passes; the account create itself throws.
    const realAccount = db().account
    const realFindUnique = ((args: unknown) => realAccount.findUnique(args as Parameters<typeof realAccount.findUnique>[0]))
    await withBrokenDb({ account: { findUnique: (args: unknown) => realFindUnique(args), create: () => Promise.reject(boom) } }, async () => {
      expect(await status(await agentsPOST(jsonBody('POST', 'http://x/api/console/agents', { name: 'Catch' }, headers)))).toBe(500)
    })

    const candlesSpy = vi.spyOn(candleCache(), 'dailyHistory').mockRejectedValueOnce(boom)
    expect(await status(await consoleCandlesGET(new Request('http://x/api/console/candles?symbol=AAPL', { headers })))).toBe(500)
    candlesSpy.mockRestore()

    const consoleQuoteSpy = vi.spyOn(quoteService(), 'getQuote').mockImplementationOnce(() => {
      throw boom
    })
    expect(await status(await consoleQuoteGET(new Request('http://x/api/console/quote?symbol=AAPL', { headers })))).toBe(500)
    consoleQuoteSpy.mockRestore()

    const wireSpy = vi.spyOn(newsWire(), 'latest').mockRejectedValueOnce(boom)
    expect(await status(await consoleNewsGET(new Request('http://x/api/console/news-wire', { headers })))).toBe(500)
    wireSpy.mockRestore()

    const detailAgent = await createAgent('edge-catch-detail')
    const detailSpy = vi.spyOn(tradingEngine(), 'metrics').mockRejectedValueOnce(boom)
    expect(await status(await agentDetailGET(new Request(`http://x/api/console/agents/${detailAgent.accountId}`, { headers }), { params: Promise.resolve({ id: detailAgent.accountId }) }))).toBe(500)
    detailSpy.mockRestore()

    const overviewSpy = vi.spyOn(quoteService(), 'getQuote').mockImplementation(() => {
      throw boom
    })
    expect(await status(await overviewGET(new Request('http://x/api/console/overview', { headers })))).toBe(500)
    overviewSpy.mockRestore()
  })
})

describe('console edge branches', () => {
  async function login(): Promise<Record<string, string>> {
    const ok = await loginPOST(jsonBody('POST', 'http://x/api/console/login', { passcode: cfg().operatorPasscode }))
    expect(ok.status).toBe(200)
    return { cookie: (ok.headers.get('set-cookie') ?? '').split(';')[0] }
  }

  it('rate-limits console login per IP', async () => {
    fillBucket('login:local', CONSOLE_RATE_LIMIT, CONSOLE_RATE_WINDOW_MS)
    const res = await loginPOST(jsonBody('POST', 'http://x/api/console/login', { passcode: 'wrong' }))
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { retryAfter: number } }
    expect(body.error.retryAfter).toBeGreaterThanOrEqual(1)
  })

  it('rejects malformed login and agent-creation bodies', async () => {
    const badLogin = await loginPOST(new Request('http://x/api/console/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json' }))
    expect(badLogin.status).toBe(400)
    expect(((await badLogin.json()) as { error: { code: string } }).error.code).toBe('invalid_json')

    const headers = await login()
    const badAgent = await agentsPOST(new Request('http://x/api/console/agents', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '[1,2,3]' }))
    expect(badAgent.status).toBe(400)
  })

  it('serves the console quote with unknown-symbol and no-quote paths', async () => {
    const headers = await login()

    const denied = await consoleQuoteGET(new Request('http://x/api/console/quote?symbol=AAPL'))
    expect(denied.status).toBe(401)

    const unknown = await consoleQuoteGET(new Request('http://x/api/console/quote?symbol=ZZZZ', { headers }))
    expect(unknown.status).toBe(404)

    const noQuote = await consoleQuoteGET(new Request('http://x/api/console/quote?symbol=MSFT', { headers }))
    expect(noQuote.status).toBe(404)
    expect(((await noQuote.json()) as { error: { code: string } }).error.code).toBe('quote_unavailable')

    const ok = await data(await consoleQuoteGET(new Request('http://x/api/console/quote?symbol=aapl', { headers })))
    expect(ok.symbol).toBe('AAPL')
  })

  it('serves the console news wire with symbol filtering and limit clamping', async () => {
    const headers = await login()

    const bare = await data(await consoleNewsGET(new Request('http://x/api/console/news-wire', { headers })))
    expect(bare.count).toBe(0)

    const clamped = await data(await consoleNewsGET(new Request('http://x/api/console/news-wire?symbol=AAPL&limit=9999', { headers })))
    expect(clamped.count).toBe(0)

    await db().newsItem.create({
      data: { providerId: 'w1', headline: 'Wire', source: 'Test', url: 'https://x/2', symbols: JSON.stringify('not-an-array'), summary: 's', publishedAt: new Date() },
    })
    const tagged = await data(await consoleNewsGET(new Request('http://x/api/console/news-wire?symbol=AAPL', { headers })))
    expect(tagged.count).toBe(0) // malformed tags never match
  })

  it('builds the overview with agents, movers, degenerate quotes and activity', async () => {
    const headers = await login()
    const creds = await createAgent('edge-overview', { startingCash: 250_000 })
    await tradingEngine().placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 2 })

    const overview = await data(await overviewGET(new Request('http://x/api/console/overview', { headers })))
    const agents = overview.agents as Array<Record<string, unknown>>
    expect(agents.length).toBe(1)
    expect(agents[0]).toMatchObject({ name: 'edge-overview' })
    expect(agents[0].equity as number).toBeGreaterThan(249_000)
    expect(agents[0].lastActivity).not.toBeNull()
    expect((overview.activity as unknown[]).length).toBeGreaterThan(0)

    const movers = overview.movers as Array<Record<string, unknown>>
    expect(movers.length).toBeGreaterThan(0)
    expect(movers.length).toBeLessThanOrEqual(10)

    // Degenerate quote: prevClose 0 must not produce Infinity in the movers.
    await quoteService().injectQuote('KO', { prevClose: 0 })
    const safe = await data(await overviewGET(new Request('http://x/api/console/overview', { headers })))
    const koMover = (safe.movers as Array<Record<string, unknown>>).find((m) => m.symbol === 'KO') as Record<string, unknown>
    expect(koMover.changePct).toBe(0)
  })

  it('skips agents the engine cannot compute metrics for', async () => {
    const headers = await login()
    await createAgent('edge-skip')
    const metricsSpy = vi.spyOn(tradingEngine(), 'metrics').mockResolvedValue(null)
    const overview = await data(await overviewGET(new Request('http://x/api/console/overview', { headers })))
    expect((overview.agents as unknown[]).length).toBe(0) // continue branch
    metricsSpy.mockRestore()
  })

  it('reports the agent detail and a missing agent', async () => {
    const headers = await login()
    const creds = await createAgent('edge-detail')

    const detail = await data(await agentDetailGET(new Request(`http://x/api/console/agents/${creds.accountId}`, { headers }), { params: Promise.resolve({ id: creds.accountId }) }))
    expect(detail.account).toMatchObject({ name: 'edge-detail' })

    const missing = await agentDetailGET(new Request('http://x/api/console/agents/nope', { headers }), { params: Promise.resolve({ id: 'nope' }) })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })
})

describe('remaining guard and clamp branches', () => {
  it('requires operator auth on every console route', async () => {
    for (const [name, call] of Object.entries({
      agents: () => agentsGET(new Request('http://x/api/console/agents')),
      agentsPost: () => agentsPOST(jsonBody('POST', 'http://x/api/console/agents', { name: 'X' })),
      agentDetail: () => agentDetailGET(new Request('http://x/api/console/agents/x'), { params: Promise.resolve({ id: 'x' }) }),
      candles: () => consoleCandlesGET(new Request('http://x/api/console/candles?symbol=AAPL')),
      newsWire: () => consoleNewsGET(new Request('http://x/api/console/news-wire')),
      quote: () => consoleQuoteGET(new Request('http://x/api/console/quote?symbol=AAPL')),
      overview: () => overviewGET(new Request('http://x/api/console/overview')),
    })) {
      const res = await call() as Response
      expect(res.status, name).toBe(401)
    }
  })

  it('requires agent keys on every v1 route', async () => {
    for (const [name, call] of Object.entries({
      account: async () => (await import('@/app/api/v1/account/route')).GET(new Request('http://x/api/v1/account')),
      activities: () => activitiesGET(new Request('http://x/api/v1/account/activities')),
      portfolio: async () => (await import('@/app/api/v1/account/portfolio/route')).GET(new Request('http://x/api/v1/account/portfolio')),
      history: () => historyGET(new Request('http://x/api/v1/account/portfolio/history')),
      candles: () => candlesGET(new Request('http://x/api/v1/market/candles?symbol=AAPL')),
      news: () => newsGET(new Request('http://x/api/v1/market/news')),
      quote: async () => (await import('@/app/api/v1/market/quote/route')).GET(new Request('http://x/api/v1/market/quote?symbol=AAPL')),
      stocks: () => stocksGET(new Request('http://x/api/v1/market/stocks')),
      stock: () => stockGET(new Request('http://x/api/v1/market/stocks/AAPL'), { params: Promise.resolve({ symbol: 'AAPL' }) }),
      orders: async () => (await import('@/app/api/v1/orders/route')).GET(new Request('http://x/api/v1/orders')),
      ordersPost: async () => (await import('@/app/api/v1/orders/route')).POST(jsonBody('POST', 'http://x/api/v1/orders', { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 })),
      orderDetail: async () => (await import('@/app/api/v1/orders/[id]/route')).GET(new Request('http://x/api/v1/orders/x'), { params: Promise.resolve({ id: 'x' }) }),
      orderDelete: async () => (await import('@/app/api/v1/orders/[id]/route')).DELETE(new Request('http://x/api/v1/orders/x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'x' }) }),
      positions: async () => (await import('@/app/api/v1/positions/route')).GET(new Request('http://x/api/v1/positions')),
      positionOne: async () => (await import('@/app/api/v1/positions/[symbol]/route')).GET(new Request('http://x/api/v1/positions/AAPL'), { params: Promise.resolve({ symbol: 'AAPL' }) }),
    })) {
      const res = await call() as Response
      expect(res.status, name).toBe(401)
    }
  })

  it('treats absent query params as their documented defaults', async () => {
    const creds = await createAgent(`edge-def-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    // missing ?symbol= entirely (no trailing '=')
    expect(await status(await candlesGET(new Request('http://x/api/v1/market/candles', { headers })))).toBe(400)
    expect(await status(await (await import('@/app/api/v1/market/quote/route')).GET(new Request('http://x/api/v1/market/quote', { headers })))).toBe(400)
    expect(await status(await consoleCandlesGET(new Request('http://x/api/console/candles', { headers: await loginCookie() })))).toBe(400)
    // console quote has no missing-symbol check — empty symbol 404s as unknown
    expect(await status(await consoleQuoteGET(new Request('http://x/api/console/quote', { headers: await loginCookie() })))).toBe(404)

    // absent limits fall back to the documented page sizes
    expect((await data(await activitiesGET(new Request('http://x/api/v1/account/activities', { headers })))).count).toBeGreaterThanOrEqual(0)
    expect((await data(await historyGET(new Request('http://x/api/v1/account/portfolio/history', { headers })))).count).toBeGreaterThanOrEqual(0)

    const wire = await data(await consoleNewsGET(new Request('http://x/api/console/news-wire?limit=abc', { headers: await loginCookie() })))
    expect(wire.count).toBe(0)
  })

  it('rejects malformed agent-creation bodies with invalid_json', async () => {
    const headers = await loginCookie()
    const bad = await agentsPOST(new Request('http://x/api/console/agents', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{ this is not json' }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_json')
  })

  it('reports not-found when metrics vanish for a known account', async () => {
    const creds = await createAgent('edge-missing-metrics')
    const spy = vi.spyOn(tradingEngine(), 'metrics').mockResolvedValue(null)
    try {
      const detail = await agentDetailGET(new Request(`http://x/api/console/agents/${creds.accountId}`, { headers: await loginCookie() }), { params: Promise.resolve({ id: creds.accountId }) })
      expect(detail.status).toBe(404)
      expect(((await detail.json()) as { error: { code: string } }).error.code).toBe('not_found')

      const account = await (await import('@/app/api/v1/account/route')).GET(new Request('http://x/api/v1/account', { headers: agentHeaders(creds.apiKey) }))
      expect(account.status).toBe(404)
      expect(((await account.json()) as { error: { code: string } }).error.code).toBe('account_not_found')
    } finally {
      spy.mockRestore()
    }
  })

  it('prices detail and portfolio rows off avgPrice when no quote exists', async () => {
    const headers = await loginCookie()
    const creds = await createAgent('edge-avgprice')
    await db().position.create({ data: { accountId: creds.accountId, symbol: 'KO', qty: 0, avgPrice: 60 } })
    await db().position.create({ data: { accountId: creds.accountId, symbol: 'AAPL', qty: 2, avgPrice: 240 } })
    const priceSpy = vi.spyOn(tradingEngine(), 'priceOf').mockReturnValue(null)
    try {
      const detail = await data(await agentDetailGET(new Request(`http://x/api/console/agents/${creds.accountId}`, { headers: await loginCookie() }), { params: Promise.resolve({ id: creds.accountId }) }))
      const aapl = (detail.positions as Array<Record<string, unknown>>).find((p) => p.symbol === 'AAPL') as Record<string, unknown>
      expect(aapl.last).toBe(240) // priceOf null -> avgPrice fallback

      const okPortfolio = await data(await (await import('@/app/api/v1/account/portfolio/route')).GET(new Request('http://x/api/v1/account/portfolio', { headers: agentHeaders(creds.apiKey) })))
      const flat = (okPortfolio.positions as Array<Record<string, unknown>>).find((p) => p.symbol === 'KO') as Record<string, unknown>
      expect(flat.last).toBe(60)
      expect(flat.unrealizedPnlPct).toBe(0) // zero cost basis suppresses the percentage

      const positions = await data(await (await import('@/app/api/v1/positions/route')).GET(new Request('http://x/api/v1/positions', { headers: agentHeaders(creds.apiKey) })))
      const ko = (positions.positions as Array<Record<string, unknown>>).find((p) => p.symbol === 'KO') as Record<string, unknown>
      expect(ko.last).toBe(60) // avgPrice fallback
    } finally {
      priceSpy.mockRestore()
    }

    // metrics-null branch on the portfolio route.
    const metricsSpy = vi.spyOn(tradingEngine(), 'metrics').mockResolvedValue(null)
    try {
      const portfolio = await (await import('@/app/api/v1/account/portfolio/route')).GET(new Request('http://x/api/v1/account/portfolio', { headers: agentHeaders(creds.apiKey) }))
      expect(portfolio.status).toBe(404)
      expect(((await portfolio.json()) as { error: { code: string } }).error.code).toBe('account_not_found')
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('serves the overview for closed sessions, quiet agents and fresh polls', async () => {
    const headers = await loginCookie()
    const creds = await createAgent('edge-quiet')
    await db().activity.deleteMany({ where: { accountId: creds.accountId } }) // no last activity
    await quoteService().pollOnce() // lastPollAt set

    setClockOverride({ frozen: Date.parse('2026-01-04T18:00:00Z') }) // Sunday
    const closed = await data(await overviewGET(new Request('http://x/api/console/overview', { headers })))
    expect((closed.session as Record<string, unknown>).nextOpen).not.toBeNull()
    const agent = (closed.agents as Array<Record<string, unknown>>)[0]
    expect(agent.lastActivity).toBeNull()
    expect((closed.marketData as Record<string, unknown>).lastPollAt).not.toBeNull()
  })

  it('validates candle symbols and serves gtc orders with null expiry', async () => {
    const creds = await createAgent(`edge-gtc-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    const unknown = await candlesGET(new Request('http://x/api/v1/market/candles?symbol=ZZZZ', { headers }))
    expect(unknown.status).toBe(404)

    const gtc = await tradingEngine().placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 1, limitPrice: 240, tif: 'gtc' })
    const list = await data(await (await import('@/app/api/v1/orders/route')).GET(new Request('http://x/api/v1/orders', { headers })))
    const row = (list.orders as Array<Record<string, unknown>>).find((o) => o.id === gtc.id) as Record<string, unknown>
    expect(row.expiresAt).toBeNull() // gtc → no expiry timestamp

    const detail = await data(await orderGET(new Request('http://x/api/v1/orders', { headers }), { params: Promise.resolve({ id: gtc.id }) }))
    expect(detail.expiresAt).toBeNull()
  })

  it('routes degenerate order bodies through the engine validation', async () => {
    const creds = await createAgent(`edge-body-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    // Empty body: every field falls back through `?? ''`.
    const empty = await (await import('@/app/api/v1/orders/route')).POST(jsonBody('POST', 'http://x/api/v1/orders', {}, headers))
    expect(empty.status).toBe(404) // unknown_symbol from ''

    // Explicit nulls hit the null-coalescing sides (tif null -> undefined).
    const nulls = await (await import('@/app/api/v1/orders/route')).POST(jsonBody('POST', 'http://x/api/v1/orders', { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1, limitPrice: null, tif: null }, headers))
    expect(nulls.status).toBe(201)
    expect(((await nulls.json()) as { data: { limitPrice: number | null; tif: string } }).data).toMatchObject({ limitPrice: null, tif: 'day' })

    // A limit order with no usable limit price is rejected by the engine.
    const noLimit = await (await import('@/app/api/v1/orders/route')).POST(jsonBody('POST', 'http://x/api/v1/orders', { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 1, limitPrice: null }, headers))
    expect(noLimit.status).toBe(400)
    expect(((await noLimit.json()) as { error: { code: string } }).error.code).toBe('invalid_limit_price')

    const withTif = await (await import('@/app/api/v1/orders/route')).POST(jsonBody('POST', 'http://x/api/v1/orders', { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 1, limitPrice: 240, tif: 'gtc' }, headers))
    expect(withTif.status).toBe(201)
  })

  it('translates rate-limit crashes into 500s on the login route', async () => {
    const boom = new Error('limiter down')
    const spy = vi.spyOn(ratelimitModule, 'rateLimit').mockImplementation(() => {
      throw boom
    })
    const res = await loginPOST(jsonBody('POST', 'http://x/api/console/login', { passcode: 'x' }))
    expect(res.status).toBe(500)
    spy.mockRestore()
  })

  async function loginCookie(): Promise<Record<string, string>> {
    const ok = await loginPOST(jsonBody('POST', 'http://x/api/console/login', { passcode: cfg().operatorPasscode }))
    return { cookie: (ok.headers.get('set-cookie') ?? '').split(';')[0] }
  }
})
