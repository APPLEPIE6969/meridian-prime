#!/usr/bin/env node
// E2E API matrix: every endpoint × auth × error shape against a running desk.

const BASE = (process.env.MERIDIAN_TEST_BASE || 'http://localhost:3000').replace(/\/+$/, '')
const PASSCODE = process.env.MERIDIAN_OPERATOR_PASSCODE || 'meridian-desk-2026'

let failures = 0
let checks = 0
function check(name, cond, detail = '') {
  checks++
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function api(pathname, { method = 'GET', key, cookie, body, raw } = {}) {
  const headers = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  if (raw) return { status: res.status, headers: res.headers, body: await res.text() }
  let json = null
  try { json = await res.json() } catch { /* ignore */ }
  return { status: res.status, json, headers: res.headers }
}

console.log(`api-matrix: ${BASE}`)

// login for console endpoints + agent for the trading API
const login = await api('/api/console/login', { method: 'POST', body: { passcode: PASSCODE } })
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
check('console login', login.status === 200 && cookie.startsWith('mp_desk='))

const created = await api('/api/console/agents', { method: 'POST', cookie, body: { name: `matrix-${Date.now()}` } })
const KEY = created.json?.data?.apiKey
check('agent created via console', created.status === 201 && KEY)

const auth = { key: KEY }
const authedCookie = { cookie }

// ── auth matrix: every agent endpoint answers 401 without a key ──────────
const agentGetters = [
  '/api/v1/account',
  '/api/v1/account/portfolio',
  '/api/v1/account/portfolio/history',
  '/api/v1/account/activities',
  '/api/v1/orders',
  '/api/v1/positions',
  '/api/v1/market/quote?symbol=AAPL',
  '/api/v1/market/stocks',
  '/api/v1/market/stocks/AAPL',
  '/api/v1/market/candles?symbol=AAPL',
  '/api/v1/market/news',
]
for (const pathname of agentGetters) {
  const res = await api(pathname)
  check(`GET ${pathname} without key -> 401`, res.status === 401 && res.json?.error?.code === 'unauthorized')
}
const postNoKey = await api('/api/v1/orders', { method: 'POST', body: { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1 } })
check('POST /orders without key -> 401', postNoKey.status === 401)

// ── public endpoints answer without auth ─────────────────────────────────
const publicPaths = ['/api/v1/market/status', '/api/v1/market/calendar', '/api/v1/docs']
for (const pathname of publicPaths) {
  const res = await api(pathname)
  check(`GET ${pathname} public -> 200`, res.status === 200 && res.json?.data)
}
const clock = await api('/api/console/clock')
check('GET /api/console/clock public -> 200', clock.status === 200 && clock.json?.data?.session)
const overviewDenied = await api('/api/console/overview')
check('GET /api/console/overview without cookie -> 401', overviewDenied.status === 401)

// ── parameter validation matrix ──────────────────────────────────────────
const cases = [
  ['/api/v1/market/quote', 'missing symbol -> 400'],
  ['/api/v1/market/quote?symbol=NOPE7', 'unknown symbol quote -> 404'],
  ['/api/v1/market/stocks/NOPE7', 'unknown instrument -> 404'],
  ['/api/v1/market/candles', 'candles missing symbol -> 400'],
  ['/api/v1/market/candles?symbol=AAPL&interval=2h', 'candles bad interval -> 400'],
  ['/api/v1/market/candles?symbol=AAPL&range=99y', 'candles bad range -> 400'],
]
for (const [pathname, label] of cases) {
  const res = await api(pathname, auth)
  check(`GET ${label}`, res.status === 400 || res.status === 404, `got ${res.status}`)
}

const orderBodies = [
  [{ symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 0 }, 'invalid_qty', 400],
  [{ symbol: 'AAPL', side: 'buy', orderType: 'market', qty: -3 }, 'invalid_qty', 400],
  [{ symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 1.5 }, 'invalid_qty', 400],
  [{ symbol: 'AAPL', side: 'sideways', orderType: 'market', qty: 1 }, 'invalid_side', 400],
  [{ symbol: 'AAPL', side: 'buy', orderType: 'bracket', qty: 1 }, 'invalid_order_type', 400],
  [{ symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 1, limitPrice: -5 }, 'invalid_limit_price', 400],
  [{ symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 1, limitPrice: 250 }, 'invalid_tif', 400, { tif: 'fok' }],
  [{ symbol: 'ZZZZ', side: 'buy', orderType: 'market', qty: 1 }, 'unknown_symbol', 404],
]
for (const [body, code, expected, extra] of orderBodies) {
  const payload = { ...body, ...(extra ?? {}) }
  const res = await api('/api/v1/orders', { method: 'POST', ...auth, body: payload })
  check(`POST order ${JSON.stringify(payload)} -> ${code}`, res.status === expected && res.json?.error?.code === code, JSON.stringify(res.json))
}

const malformed = await api('/api/v1/orders', { method: 'POST', ...auth, raw: 1, body: undefined })
check('POST /orders empty body -> 400 invalid_json', malformed.status === 400 && malformed.body.includes('invalid_json'))

// ── success matrix over every GET endpoint with a valid key ─────────────
const okPaths = [
  '/api/v1/account',
  '/api/v1/account/portfolio',
  '/api/v1/account/portfolio/history',
  '/api/v1/account/activities',
  '/api/v1/orders',
  '/api/v1/orders?status=working',
  '/api/v1/positions',
  '/api/v1/market/quote?symbol=AAPL',
  '/api/v1/market/stocks',
  '/api/v1/market/stocks?sector=Energy',
  '/api/v1/market/stocks/XLK',
  '/api/v1/market/candles?symbol=AAPL&interval=1d&range=1y',
  '/api/v1/market/candles?symbol=AAPL&interval=1m',
  '/api/v1/market/news?limit=3',
]
for (const pathname of okPaths) {
  const res = await api(pathname, auth)
  check(`GET ${pathname} -> 200 envelope`, res.status === 200 && res.json?.data !== undefined, `got ${res.status}`)
}

// console endpoints with the operator cookie
const consolePaths = [
  '/api/console/overview',
  '/api/console/agents',
  '/api/console/candles?symbol=AAPL&interval=1d',
  '/api/console/quote?symbol=MSFT',
  '/api/console/news-wire?limit=3',
]
for (const pathname of consolePaths) {
  const res = await api(pathname, authedCookie)
  check(`GET ${pathname} with cookie -> 200`, res.status === 200 && res.json?.data !== undefined, `got ${res.status}`)
}

// ── error envelope shape ─────────────────────────────────────────────────
const err = await api('/api/v1/market/quote?symbol=', auth)
check('error envelope is { error: { code, message } }', err.json?.error?.code === 'missing_symbol' && typeof err.json.error.message === 'string')

// 404 on unknown API path
const missing = await api('/api/v1/definitely/not/here', auth)
check('unknown API path -> 404', missing.status === 404)

console.log(failures === 0 ? `\napi-matrix: ${checks} CHECKS ALL GREEN` : `\napi-matrix: ${failures}/${checks} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
