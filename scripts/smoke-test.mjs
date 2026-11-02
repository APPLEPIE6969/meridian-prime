#!/usr/bin/env node
// E2E smoke: the full trading lifecycle against a running desk.
//   MERIDIAN_TEST_BASE=http://localhost:3000 node scripts/smoke-test.mjs
//
// Expects an operator session (default passcode unless overridden) and a
// market-data feed with quotes flowing (fixture or live).

const BASE = (process.env.MERIDIAN_TEST_BASE || 'http://localhost:3000').replace(/\/+$/, '')
const PASSCODE = process.env.MERIDIAN_OPERATOR_PASSCODE || 'meridian-desk-2026'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function api(pathname, { method = 'GET', key, cookie, body } = {}) {
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
  let json = null
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(everyMs)
  }
  return null
}

console.log(`smoke: ${BASE}`)

// ── public surface ───────────────────────────────────────────────────────
const status = await api('/api/v1/market/status')
check('status is public and healthy', status.status === 200 && status.json?.data?.session?.state)
const quoteCount = status.json?.data?.marketData?.quotesLive ?? 0
check('quotes are flowing', quoteCount > 0, `quotesLive=${quoteCount}`)

const docs = await api('/api/v1/docs')
check('machine docs are public', docs.status === 200 && docs.json?.data?.endpoints)

const calendar = await api('/api/v1/market/calendar')
check('calendar exposes the trading schedule', calendar.status === 200 && calendar.json?.data?.regularSchedule?.regular?.open === '09:30')

// ── operator login + agent provisioning ──────────────────────────────────
const login = await api('/api/console/login', { method: 'POST', body: { passcode: PASSCODE } })
check('operator login works', login.status === 200)
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

const wrongPass = await api('/api/console/login', { method: 'POST', body: { passcode: 'definitely-wrong' } })
check('wrong passcode rejected', wrongPass.status === 401)

const agentName = `smoke-${Date.now()}`
const created = await api('/api/console/agents', { method: 'POST', cookie, body: { name: agentName, startingCash: 50_000_000, kind: 'margin' } })
check('agent account created', created.status === 201 && String(created.json?.data?.apiKey ?? '').startsWith('mrp_live_'))
const KEY = created.json?.data?.apiKey
const ACCOUNT_ID = created.json?.data?.accountId

const denied = await api('/api/v1/account')
check('agent API requires the key', denied.status === 401)

// ── market data over the agent API ───────────────────────────────────────
const quote = await api('/api/v1/market/quote?symbol=AAPL', { key: KEY })
check('agent can pull a live quote', quote.status === 200 && quote.json?.data?.ask > quote.json?.data?.bid)

const stocks = await api('/api/v1/market/stocks', { key: KEY })
check('universe is served', stocks.status === 200 && stocks.json?.data?.count >= 51)

// ── trading: market order fills against the book ────────────────────────
const ask = quote.json.data.ask
const market = await api('/api/v1/orders', { method: 'POST', key: KEY, body: { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 10 } })
check('market order accepted', market.status === 201)
check('market order filled above the touch', market.json?.data?.status === 'filled' && market.json?.data?.avgFillPrice >= ask, JSON.stringify(market.json))

// ── trading: big order grinds against liquidity ──────────────────────────
const big = await api('/api/v1/orders', { method: 'POST', key: KEY, body: { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 250000 } })
check('large order accepted', big.status === 201)
const grinded = await waitFor(async () => {
  const detail = await api(`/api/v1/orders/${big.json.data.id}`, { key: KEY })
  return (detail.json?.data?.filledQty ?? 0) >= 10_000 ? detail.json.data : null
}, 45_000)
check('large order prints in volume-capped slices across ticks', grinded !== null && (grinded.fills?.length ?? 0) >= 2, JSON.stringify(grinded && { filled: grinded.filledQty, slices: grinded.fills?.length }))

// Don't leave a 250k-share order consuming every future tick — the market
// is time-priority FIFO and later suites deserve liquidity too.
if (big.json?.data?.id) {
  const stillWorking = await api(`/api/v1/orders/${big.json.data.id}`, { key: KEY })
  if (stillWorking.json?.data?.status === 'working' || stillWorking.json?.data?.status === 'partially_filled') {
    await api(`/api/v1/orders/${big.json.data.id}`, { method: 'DELETE', key: KEY })
  }
}

// ── trading: resting limit + cancel ──────────────────────────────────────
const resting = await api('/api/v1/orders', { method: 'POST', key: KEY, body: { symbol: 'MSFT', side: 'buy', orderType: 'limit', qty: 5, limitPrice: Math.floor(quote.json.data.last * 0.5), tif: 'gtc' } })
check('unmarketable limit rests', resting.status === 201 && resting.json?.data?.status === 'working')

const cancel = await api(`/api/v1/orders/${resting.json.data.id}`, { method: 'DELETE', key: KEY })
check('working order cancels', cancel.status === 200 && cancel.json?.data?.status === 'canceled')

// ── validation realism ───────────────────────────────────────────────────
const unknown = await api('/api/v1/orders', { method: 'POST', key: KEY, body: { symbol: 'ZZZZ', side: 'buy', orderType: 'market', qty: 1 } })
check('unknown symbol rejected', unknown.status === 404 && unknown.json?.error?.code === 'unknown_symbol')

const badQty = await api('/api/v1/orders', { method: 'POST', key: KEY, body: { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 2.5 } })
check('fractional shares rejected', badQty.status === 400 && badQty.json?.error?.code === 'invalid_qty')

const tooBig = await api('/api/v1/orders', { method: 'POST', key: KEY, body: { symbol: 'AAPL', side: 'buy', orderType: 'limit', qty: 500000, limitPrice: 250 } })
check('over-BP order rejected', tooBig.status === 422 && tooBig.json?.error?.code === 'insufficient_buying_power')

// ── account surface ──────────────────────────────────────────────────────
const account = await api('/api/v1/account', { key: KEY })
check('account shows cash deployed and margin', account.status === 200 && account.json?.data?.equity > 0 && account.json?.data?.cash < 50_000_000)

const portfolio = await api('/api/v1/account/portfolio', { key: KEY })
check('portfolio carries the position', portfolio.status === 200 && portfolio.json?.data?.positions?.some((p) => p.symbol === 'AAPL' && p.qty > 0))

const positions = await api('/api/v1/positions/AAPL', { key: KEY })
check('single-position endpoint works', positions.status === 200 && positions.json?.data?.qty > 0)

const orders = await api('/api/v1/orders?status=filled', { key: KEY })
check('order history with fills', orders.status === 200 && orders.json?.data?.orders?.every((o) => o.status === 'filled'))

const activities = await api('/api/v1/account/activities', { key: KEY })
check('activity journal records fills', activities.status === 200 && activities.json?.data?.activities?.some((a) => a.kind === 'fill'))

const history = await api('/api/v1/account/portfolio/history', { key: KEY })
check('equity snapshots recorded', history.status === 200 && history.json?.data?.points?.length > 0)

const candles = await api('/api/v1/market/candles?symbol=AAPL&interval=1d&range=1y', { key: KEY })
check('daily candles served', candles.status === 200 && candles.json?.data?.bars?.length > 100)

const news = await api('/api/v1/market/news?limit=5', { key: KEY })
check('news wire reachable', news.status === 200)

// ── console surface ──────────────────────────────────────────────────────
const overview = await api('/api/console/overview', { cookie })
check('desk overview shows the agent', overview.status === 200 && overview.json?.data?.agents?.some((a) => a.name === agentName))

const detail = await api(`/api/console/agents/${ACCOUNT_ID}`, { cookie })
check('agent detail is observable', detail.status === 200 && detail.json?.data?.fills?.length > 0)

// ── stealth sanity on the running system ─────────────────────────────────
const banned = /\bpaper\b|simulat|\bfake\b|virtual|\bpractice\b|\bdemo\b|play[- ]?money|monopoly|\bsandbox\b/i
const surface = JSON.stringify({ status: status.json, docs: docs.json, account: account.json, err: unknown.json, big: big.json })
check('agent-facing responses stay clean of simulation vocabulary', !banned.test(surface))

console.log(failures === 0 ? '\nsmoke: ALL GREEN' : `\nsmoke: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
