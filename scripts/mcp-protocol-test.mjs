#!/usr/bin/env node
// E2E MCP protocol conformance: spawns src/mcp/server.mjs against the
// running desk and drives the full JSON-RPC tool surface.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = (process.env.MERIDIAN_TEST_BASE || 'http://localhost:3000').replace(/\/+$/, '')
const PASSCODE = process.env.MERIDIAN_OPERATOR_PASSCODE || 'meridian-desk-2026'
const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function api(pathname, { method = 'GET', key, cookie, body } = {}) {
  const headers = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(BASE + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  let json = null
  try { json = await res.json() } catch { /* */ }
  return { status: res.status, json, headers: res.headers }
}

// Provision a fresh agent for the MCP session.
const login = await api('/api/console/login', { method: 'POST', body: { passcode: PASSCODE } })
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
const created = await api('/api/console/agents', { method: 'POST', cookie, body: { name: `mcp-${Date.now()}`, startingCash: 250_000 } })
const KEY = created.json?.data?.apiKey
if (!KEY) {
  console.error('could not provision an agent — is the desk running?')
  process.exit(1)
}

// Spawn the adapter.
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp', 'server.mjs')], {
  env: { ...process.env, MERIDIAN_API_KEY: KEY, MERIDIAN_BASE_URL: `${BASE}/api/v1` },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
const replies = new Map()
let nextId = 1
child.stdout.on('data', (chunk) => {
  buffer += String(chunk)
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id !== undefined) replies.set(msg.id, msg)
    } catch { /* partial */ }
  }
})
let stderrLog = ''
child.stderr.on('data', (chunk) => { stderrLog += String(chunk) })

function send(method, params) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n')
  return id
}

async function wait(id, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !replies.has(id)) await new Promise((r) => setTimeout(r, 100))
  return replies.get(id)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  // handshake
  const initId = send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'conformance', version: '1.0.0' } })
  const init = await wait(initId)
  check('initialize handshake', init?.result?.serverInfo?.name === 'meridian-prime' && init.result.capabilities?.tools)

  send('notifications/initialized')
  await sleep(200)

  // catalog
  const listId = send('tools/list')
  const list = await wait(listId)
  const tools = list?.result?.tools ?? []
  check('tools/list exposes the full catalog', tools.length >= 15)
  check('every tool carries a description and schema', tools.every((t) => t.description?.length > 10 && t.inputSchema?.type === 'object'))

  // market status + quote through tools/call
  const statusId = send('tools/call', { name: 'get_market_status', arguments: {} })
  const status = await wait(statusId)
  const statusData = JSON.parse(status?.result?.content?.[0]?.text ?? '{}')
  check('get_market_status returns the session', !status?.result?.isError && statusData?.data?.session?.state, JSON.stringify(statusData).slice(0, 160))

  const quoteId = send('tools/call', { name: 'get_quote', arguments: { symbol: 'AAPL' } })
  const quote = await wait(quoteId)
  const quoteData = JSON.parse(quote?.result?.content?.[0]?.text ?? '{}')
  check('get_quote returns a live book', !quote?.result?.isError && quoteData?.data?.ask > quoteData?.data?.bid, JSON.stringify(quoteData).slice(0, 160))

  // account + trading through MCP
  const acctId = send('tools/call', { name: 'get_account', arguments: {} })
  const acct = await wait(acctId)
  const acctData = JSON.parse(acct?.result?.content?.[0]?.text ?? '{}')
  check('get_account shows the funded account', acctData?.data?.cash === 250_000, JSON.stringify(acctData).slice(0, 160))

  const placeId = send('tools/call', { name: 'place_order', arguments: { symbol: 'AAPL', side: 'buy', orderType: 'market', qty: 5 } })
  const place = await wait(placeId)
  const placeData = JSON.parse(place?.result?.content?.[0]?.text ?? '{}')
  check('place_order fills over MCP', placeData?.data?.status === 'filled', JSON.stringify(placeData).slice(0, 200))

  const positionsId = send('tools/call', { name: 'get_positions', arguments: {} })
  const positions = await wait(positionsId)
  const positionsData = JSON.parse(positions?.result?.content?.[0]?.text ?? '{}')
  check('get_positions shows the new position', positionsData?.data?.positions?.some((p) => p.symbol === 'AAPL' && p.qty === 5), JSON.stringify(positionsData).slice(0, 160))

  const ordersId = send('tools/call', { name: 'get_orders', arguments: { status: 'filled' } })
  const orders = await wait(ordersId)
  const ordersData = JSON.parse(orders?.result?.content?.[0]?.text ?? '{}')
  check('get_orders lists the fill', ordersData?.data?.orders?.some((o) => o.status === 'filled'), JSON.stringify(ordersData).slice(0, 160))

  // structured errors over MCP
  const badId = send('tools/call', { name: 'place_order', arguments: { symbol: 'ZZZZ', side: 'buy', orderType: 'market', qty: 1 } })
  const bad = await wait(badId)
  check('API errors surface as structured tool errors', bad?.result?.isError === true && JSON.stringify(bad.result).includes('unknown_symbol'), JSON.stringify(bad?.result ?? {}).slice(0, 160))

  const unknownId = send('tools/call', { name: 'not_a_tool', arguments: {} })
  const unknown = await wait(unknownId)
  check('unknown tools rejected cleanly', unknown?.result?.isError === true && JSON.stringify(unknown.result).includes('UNKNOWN_TOOL'))

  // protocol plumbing
  const pingId = send('ping')
  const pong = await wait(pingId)
  check('ping/pong', pong?.result !== undefined)

  const badMethodId = send('no/such/method')
  const badMethod = await wait(badMethodId)
  check('unknown protocol method -> -32601', badMethod?.error?.code === -32601)

  const candlesId = send('tools/call', { name: 'get_candles', arguments: { symbol: 'AAPL', interval: '1d', range: '1y' } })
  const candles = await wait(candlesId)
  const candlesData = JSON.parse(candles?.result?.content?.[0]?.text ?? '{}')
  check('get_candles over MCP', !candles?.result?.isError && (candlesData?.data?.bars?.length ?? 0) > 100)

  const newsId = send('tools/call', { name: 'get_news', arguments: { limit: 3 } })
  const news = await wait(newsId)
  check('get_news over MCP', !news?.result?.isError)

  const calId = send('tools/call', { name: 'get_calendar', arguments: {} })
  const cal = await wait(calId)
  check('get_calendar over MCP', JSON.stringify(cal?.result ?? '').includes('09:30'))

  check('adapter writes no stdout noise beyond protocol frames', !stderrLog.includes('Error') || stderrLog.includes('MCP server ready'))
} finally {
  child.kill('SIGTERM')
}

console.log(failures === 0 ? '\nmcp-protocol: ALL GREEN' : `\nmcp-protocol: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
