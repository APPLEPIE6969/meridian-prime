import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetClock, setClockOverride } from '@/lib/clock'
import { createAgent } from '@/lib/engine/accounts'
import { resetTradingEngine, tradingEngine } from '@/lib/engine/engine'
import { quoteService, resetQuoteService } from '@/lib/market/quotes'
import { db } from '@/lib/db'
import { resetRateLimits } from '@/lib/api/ratelimit'
import { DESK_COOKIE, deskToken } from '@/lib/api/auth'
import { cfg } from '@/lib/config'

import { GET as statusGET } from '@/app/api/v1/market/status/route'
import { GET as calendarGET } from '@/app/api/v1/market/calendar/route'
import { GET as docsGET } from '@/app/api/v1/docs/route'
import { GET as quoteGET } from '@/app/api/v1/market/quote/route'
import { GET as stocksGET } from '@/app/api/v1/market/stocks/route'
import { GET as stockGET } from '@/app/api/v1/market/stocks/[symbol]/route'
import { GET as candlesGET } from '@/app/api/v1/market/candles/route'
import { GET as accountGET } from '@/app/api/v1/account/route'
import { GET as portfolioGET } from '@/app/api/v1/account/portfolio/route'
import { GET as historyGET } from '@/app/api/v1/account/portfolio/history/route'
import { GET as activitiesGET } from '@/app/api/v1/account/activities/route'
import { GET as ordersGET, POST as ordersPOST } from '@/app/api/v1/orders/route'
import { GET as orderGET, DELETE as orderDELETE } from '@/app/api/v1/orders/[id]/route'
import { GET as positionsGET } from '@/app/api/v1/positions/route'
import { GET as positionGET } from '@/app/api/v1/positions/[symbol]/route'
import { POST as loginPOST, DELETE as loginDELETE } from '@/app/api/console/login/route'
import { GET as overviewGET } from '@/app/api/console/overview/route'
import { GET as agentsGET, POST as agentsPOST } from '@/app/api/console/agents/route'
import { GET as agentDetailGET } from '@/app/api/console/agents/[id]/route'
import { GET as consoleCandlesGET } from '@/app/api/console/candles/route'
import { GET as consoleQuoteGET } from '@/app/api/console/quote/route'
import { GET as consoleNewsGET } from '@/app/api/console/news-wire/route'
import { GET as clockGET } from '@/app/api/console/clock/route'

const OPEN = Date.parse('2026-01-05T14:30:00Z')

function agentHeaders(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` }
}

function jsonBody(method: string, url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

async function data(res: Response): Promise<Record<string, unknown>> {
  expect(res.status).toBeLessThan(500)
  return (await res.json()).data
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
  resetClock()
  setClockOverride({ frozen: OPEN })
  tradingEngine().wireMarketFeed()
  await quoteService().injectQuote('AAPL', { last: 250, bid: 249.99, ask: 250.01, prevClose: 248, dayVolume: 5_000_000 })
  await quoteService().injectQuote('KO', { last: 60, bid: 59.99, ask: 60.01, prevClose: 60, dayVolume: 8_000_000 })
  await wipe()
})

afterEach(() => {
  resetClock()
  resetQuoteService()
  resetTradingEngine()
})

describe('public endpoints', () => {
  it('exposes market status without auth', async () => {
    const res = await statusGET()
    expect(res.status).toBe(200)
    const payload = await data(res)
    expect(payload.session).toMatchObject({ state: 'open' })
    expect(payload.marketData).toMatchObject({ provider: 'live' })
  })

  it('exposes the calendar without auth', async () => {
    const res = await calendarGET()
    const payload = await data(res)
    expect(payload.today).toMatchObject({ tradingDay: true, state: 'open' })
    expect(((payload.regularSchedule as Record<string, { open: string; close: string }>).regular)).toEqual({ open: '09:30', close: '16:00' })
    expect(Array.isArray(payload.upcomingHolidays)).toBe(true)
  })

  it('exposes the API docs and the desk clock without auth', async () => {
    const docs = await data(await docsGET())
    expect(docs.name).toContain('trading API')
    expect(Object.keys(docs.endpoints as Record<string, string>).length).toBeGreaterThan(10)

    const clock = await data(await clockGET())
    expect(String(clock.now)).toContain('2026-01-05')
  })
})

describe('agent authentication', () => {
  it('rejects missing and unknown keys on every agent endpoint', async () => {
    const noKey = await accountGET(new Request('http://x/api/v1/account'))
    expect(noKey.status).toBe(401)

    const badKey = await accountGET(new Request('http://x/api/v1/account', { headers: agentHeaders('mrp_live_nope') }))
    expect(badKey.status).toBe(401)

    const junkHeader = await accountGET(new Request('http://x/api/v1/account', { headers: { authorization: 'Basic abc' } }))
    expect(junkHeader.status).toBe(401)
  })
})

describe('account + portfolio endpoints', () => {
  it('return the full account state and positions', async () => {
    const creds = await createAgent(`routes-${Date.now()}`, { startingCash: 250_000 })
    const headers = agentHeaders(creds.apiKey)

    const account = await data(await accountGET(new Request('http://x/api/v1/account', { headers })))
    expect(account).toMatchObject({ name: creds.name, kind: 'margin', cash: 250_000, equity: 250_000, buyingPower: 500_000 })

    await tradingEngine().placeOrder(creds.accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 10 })

    const portfolio = await data(await portfolioGET(new Request('http://x/api/v1/account/portfolio', { headers })))
    expect(portfolio.positions).toHaveLength(1)
    const position = (portfolio.positions as Array<Record<string, unknown>>)[0]
    expect(position).toMatchObject({ symbol: 'AAPL', qty: 10 })
    expect((portfolio.totals as Record<string, number>).equity).toBeGreaterThan(0)

    const positions = await data(await positionsGET(new Request('http://x/api/v1/positions', { headers })))
    expect(positions.count).toBe(1)

    const one = await data(await positionGET(new Request('http://x/api/v1/positions/AAPL', { headers }), { params: Promise.resolve({ symbol: 'AAPL' }) }))
    expect(one).toMatchObject({ symbol: 'AAPL' })

    const missing = await positionGET(new Request('http://x/api/v1/positions/KO', { headers }), { params: Promise.resolve({ symbol: 'KO' }) })
    expect(missing.status).toBe(404)

    const history = await data(await historyGET(new Request('http://x/api/v1/account/portfolio/history', { headers })))
    expect((history.points as unknown[]).length).toBeGreaterThan(0)

    const activities = await data(await activitiesGET(new Request('http://x/api/v1/account/activities', { headers })))
    expect((activities.activities as unknown[]).length).toBeGreaterThan(0)
  })
})

describe('order endpoints', () => {
  it('place, list, fetch and cancel orders over HTTP', async () => {
    const creds = await createAgent(`orders-${Date.now()}`, { startingCash: 100_000 })
    const headers = agentHeaders(creds.apiKey)

    const created = await ordersPOST(jsonBody('POST', 'http://x/api/v1/orders', { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 5 }, { ...headers }))
    expect(created.status).toBe(201)
    const order = await data(created) as Record<string, unknown>
    expect(order).toMatchObject({ symbol: 'AAPL', status: 'filled' })

    const list = await data(await ordersGET(new Request('http://x/api/v1/orders', { headers })))
    expect(list.count).toBe(1)

    const working = await data(await ordersGET(new Request('http://x/api/v1/orders?status=working', { headers })))
    expect(working.count).toBe(0)

    const rest = await ordersPOST(jsonBody('POST', 'http://x/api/v1/orders', { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 5, limitPrice: 240 }, { ...headers }))
    const restOrder = await data(rest) as Record<string, unknown>

    const detail = await data(await orderGET(new Request('http://x/api/v1/orders', { headers }), { params: Promise.resolve({ id: restOrder.id as string }) }))
    expect(detail.id).toBe(restOrder.id)

    const canceled = await data(await orderDELETE(new Request('http://x/api/v1/orders', { method: 'DELETE', headers }), { params: Promise.resolve({ id: restOrder.id as string }) }))
    expect(canceled).toMatchObject({ status: 'canceled' })

    const foreign = await orderGET(new Request('http://x/api/v1/orders', { headers: agentHeaders((await createAgent(`other-${Date.now()}`)).apiKey) }), { params: Promise.resolve({ id: restOrder.id as string }) })
    expect(foreign.status).toBe(404)
  })

  it('surface engine validation errors with structured codes', async () => {
    const creds = await createAgent(`val-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    const bad = await ordersPOST(jsonBody('POST', 'http://x/api/v1/orders', { symbol: 'ZZZZ', side: 'buy', orderType: 'market', qty: 1 }, { ...headers }))
    expect(bad.status).toBe(404)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('unknown_symbol')

    const noBody = await ordersPOST(new Request('http://x/api/v1/orders', { method: 'POST', headers }))
    expect(noBody.status).toBe(400)
  })
})

describe('market data endpoints', () => {
  it('serve quotes, universe, instrument detail and candles', async () => {
    const creds = await createAgent(`mkt-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)

    const quote = await data(await quoteGET(new Request('http://x/api/v1/market/quote?symbol=AAPL', { headers })))
    expect(quote).toMatchObject({ symbol: 'AAPL' })

    const missing = await quoteGET(new Request('http://x/api/v1/market/quote?symbol=', { headers }))
    expect(missing.status).toBe(400)

    const none = await quoteGET(new Request('http://x/api/v1/market/quote?symbol=KO2', { headers }))
    expect(none.status).toBe(404)

    const stocks = await data(await stocksGET(new Request('http://x/api/v1/market/stocks?sector=Energy', { headers })))
    expect((stocks.instruments as unknown[]).length).toBeGreaterThan(0)

    const stock = await data(await stockGET(new Request('http://x/api/v1/market/stocks/AAPL', { headers }), { params: Promise.resolve({ symbol: 'AAPL' }) }))
    expect(stock).toMatchObject({ symbol: 'AAPL' })

    const unknown = await stockGET(new Request('http://x/api/v1/market/stocks/ZZZZ', { headers }), { params: Promise.resolve({ symbol: 'ZZZZ' }) })
    expect(unknown.status).toBe(404)

    const daily = await data(await candlesGET(new Request('http://x/api/v1/market/candles?symbol=AAPL&interval=1d&range=1y', { headers })))
    expect((daily.bars as unknown[]).length).toBeGreaterThan(100)

    const intraday = await data(await candlesGET(new Request('http://x/api/v1/market/candles?symbol=AAPL&interval=1m', { headers })))
    expect((intraday.bars as unknown[]).length).toBeGreaterThan(0)

    const badRange = await candlesGET(new Request('http://x/api/v1/market/candles?symbol=AAPL&range=10y', { headers }))
    expect(badRange.status).toBe(400)
    const badInterval = await candlesGET(new Request('http://x/api/v1/market/candles?symbol=AAPL&interval=5m', { headers }))
    expect(badInterval.status).toBe(400)
  })

  it('rate-limits by API key', async () => {
    const creds = await createAgent(`rl-${Date.now()}`)
    const headers = agentHeaders(creds.apiKey)
    const url = 'http://x/api/v1/market/quote?symbol=AAPL'
    let lastStatus = 200
    for (let i = 0; i < 121; i++) {
      lastStatus = (await quoteGET(new Request(url, { headers }))).status
    }
    expect(lastStatus).toBe(429)
  })
})

describe('console endpoints', () => {
  it('gate everything behind the operator passcode', async () => {
    const denied = await overviewGET(new Request('http://x/api/console/overview'))
    expect(denied.status).toBe(401)
  })

  it('log in with the right passcode and serve the desk', async () => {
    const ok = await loginPOST(jsonBody('POST', 'http://x/api/console/login', { passcode: cfg().operatorPasscode }))
    expect(ok.status).toBe(200)
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie).toContain(DESK_COOKIE)

    const wrong = await loginPOST(jsonBody('POST', 'http://x/api/console/login', { passcode: 'wrong' }))
    expect(wrong.status).toBe(401)

    const headers = { cookie }
    const overview = await data(await overviewGET(new Request('http://x/api/console/overview', { headers })))
    expect(overview.agents).toEqual([])
    expect(overview.session).toMatchObject({ state: 'open' })

    const created = await agentsPOST(jsonBody('POST', 'http://x/api/console/agents', { name: 'Console Agent', startingCash: 500_000, kind: 'cash' }, headers))
    expect(created.status).toBe(201)
    const agent = await data(created) as Record<string, unknown>
    expect(String(agent.apiKey)).toMatch(/^mrp_live_/)

    const list = await data(await agentsGET(new Request('http://x/api/console/agents', { headers })))
    expect(list.count).toBe(1)

    const detail = await data(await agentDetailGET(new Request('http://x/api/console/agents', { headers }), { params: Promise.resolve({ id: agent.accountId as string }) }))
    expect(detail.account).toMatchObject({ name: 'Console Agent' })

    const logout = await loginDELETE()
    expect((logout.headers.get('set-cookie') ?? '').length).toBeGreaterThan(0)
  })

  it('rejects duplicate agent names and invalid input', async () => {
    const ok = await loginPOST(jsonBody('POST', 'http://x/api/console/login', { passcode: cfg().operatorPasscode }))
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0]
    const headers = { cookie }

    await agentsPOST(jsonBody('POST', 'http://x/api/console/agents', { name: 'Dup' }, headers))
    const dup = await agentsPOST(jsonBody('POST', 'http://x/api/console/agents', { name: 'Dup' }, headers))
    expect(dup.status).toBe(409)

    const bad = await agentsPOST(jsonBody('POST', 'http://x/api/console/agents', { name: '' }, headers))
    expect(bad.status).toBe(400)

    const badCash = await agentsPOST(jsonBody('POST', 'http://x/api/console/agents', { name: 'X', startingCash: -5 }, headers))
    expect(badCash.status).toBe(400)
  })

  it('serves console candles, quotes, news and the full agent detail', async () => {
    const ok = await loginPOST(jsonBody('POST', 'http://x/api/console/login', { passcode: cfg().operatorPasscode }))
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0]
    const headers = { cookie }

    const candles = await data(await consoleCandlesGET(new Request('http://x/api/console/candles?symbol=AAPL&interval=1m', { headers })))
    expect((candles.bars as unknown[]).length).toBeGreaterThan(0)

    const daily = await data(await consoleCandlesGET(new Request('http://x/api/console/candles?symbol=AAPL&interval=1d', { headers })))
    expect((daily.bars as unknown[]).length).toBeGreaterThan(100)

    const badSymbol = await consoleCandlesGET(new Request('http://x/api/console/candles?symbol=', { headers }))
    expect(badSymbol.status).toBe(400)
    const unknown = await consoleCandlesGET(new Request('http://x/api/console/candles?symbol=ZZZZ', { headers }))
    expect(unknown.status).toBe(404)

    const quote = await data(await consoleQuoteGET(new Request('http://x/api/console/quote?symbol=AAPL', { headers })))
    expect(quote).toMatchObject({ symbol: 'AAPL' })

    const news = await data(await consoleNewsGET(new Request('http://x/api/console/news-wire?symbol=AAPL', { headers })))
    expect(news.count).toBe(0) // wire not refreshed in this suite

    // Full detail with orders, fills, positions and an equity curve.
    const created = await agentsPOST(jsonBody('POST', 'http://x/api/console/agents', { name: 'Detail' }, headers))
    const agent = await data(created) as Record<string, unknown>
    const accountId = String(agent.accountId)
    await tradingEngine().placeOrder(accountId, { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 5 })
    await tradingEngine().placeOrder(accountId, { symbol: 'KO', side: 'buy', orderType: 'limit', qty: 5, limitPrice: 10 })
    await tradingEngine().snapshotSweep()

    const detail = await data(await agentDetailGET(new Request(`http://x/api/console/agents/${accountId}`, { headers }), { params: Promise.resolve({ id: accountId }) }))
    expect(detail.account).toMatchObject({ name: 'Detail' })
    expect((detail.positions as unknown[]).length).toBe(1)
    expect((detail.orders as unknown[]).length).toBe(2)
    expect((detail.fills as unknown[]).length).toBe(1)
    expect((detail.equityCurve as unknown[]).length).toBeGreaterThan(0)

    const missing = await agentDetailGET(new Request('http://x/api/console/agents/nope', { headers }), { params: Promise.resolve({ id: 'nope' }) })
    expect(missing.status).toBe(404)
  })
})
