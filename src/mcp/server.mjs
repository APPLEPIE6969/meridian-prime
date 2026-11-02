#!/usr/bin/env node
// ─── Meridian Prime — MCP adapter ─────────────────────────────────────────
// A Model Context Protocol server that exposes the desk's trading API as
// tools so MCP clients (Claude Desktop, Claude Code, Cursor, ...) can trade
// without touching HTTP. One process per account: point MERIDIAN_API_KEY at
// the account's mrp_live_ key in the client config — the key never appears
// in any tool result, only in the Authorization header of outbound calls.
//
// Config (env):
//   MERIDIAN_API_KEY   required — the account API key (mrp_live_...)
//   MERIDIAN_BASE_URL  optional — default http://localhost:3000/api/v1
//
// Transport: stdio, newline-delimited JSON-RPC 2.0 (MCP stdio framing).
// NOTHING may be written to stdout except protocol messages; diagnostics go
// to stderr. Tool descriptions are worded like a live brokerage — they must
// never reference testing or simulation.

import { createInterface } from 'node:readline'

const BASE_URL = (process.env.MERIDIAN_BASE_URL || 'http://localhost:3000/api/v1').replace(/\/+$/, '')
const API_KEY = process.env.MERIDIAN_API_KEY || ''
const SERVER = { name: 'meridian-prime', version: '1.0.0' }
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']

if (!API_KEY) {
  console.error('[meridian-prime] MERIDIAN_API_KEY is not set. Add it to the MCP server config env block.')
  process.exit(1)
}

// ── REST helper ───────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = json?.error ?? { code: `HTTP_${res.status}`, message: text.slice(0, 300) }
    const e = new Error(JSON.stringify(err))
    e.isApiError = true
    e.payload = err
    throw e
  }
  return json
}

const num = { type: 'number' }
const str = { type: 'string' }

// ── Tool catalog ──────────────────────────────────────────────────────────
// Descriptions are customer-facing copy: plain brokerage language only.
const TOOLS = [
  {
    name: 'get_market_status',
    description: 'Current US market session: open/closed, session phase (pre/regular/post), exchange clock and data feed health.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_calendar',
    description: 'Trading calendar: regular hours, early closes and upcoming market holidays.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_stocks',
    description: 'The 48 tradable US listings (companies + sector ETFs), optionally filtered by sector, with live quotes.',
    inputSchema: { type: 'object', properties: { sector: { ...str, description: 'e.g. Technology, Energy, Health Care' } } },
  },
  {
    name: 'get_quote',
    description: 'Latest quote for a symbol: bid/ask and sizes, last price, prior close, day range, volume.',
    inputSchema: { type: 'object', properties: { symbol: str }, required: ['symbol'] },
  },
  {
    name: 'get_candles',
    description: 'OHLCV price bars for a symbol. interval: 1m (today) or 1d; range: 1d, 5d, 1mo, 6mo, 1y or 5y.',
    inputSchema: { type: 'object', properties: { symbol: str, interval: { ...str, enum: ['1m', '1d'] }, range: { ...str, enum: ['1d', '5d', '1mo', '6mo', '1y', '5y'] } }, required: ['symbol'] },
  },
  {
    name: 'get_news',
    description: 'Recent market headlines from the news wire, optionally filtered by symbol.',
    inputSchema: { type: 'object', properties: { symbol: str, limit: { ...num, maximum: 100 } } },
  },
  {
    name: 'get_account',
    description: 'Your brokerage account: cash, settled cash, equity, buying power, margin usage and day-trade counters.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_portfolio',
    description: 'Consolidated portfolio view: open positions with market values and P&L, plus account totals.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_portfolio_history',
    description: 'Equity curve of your account from intraday snapshots.',
    inputSchema: { type: 'object', properties: { limit: { ...num, maximum: 2000 } } },
  },
  {
    name: 'get_positions',
    description: 'All open positions (long and short) with quantity, average entry, market value and unrealized P/L.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_position',
    description: 'Your open position in a single symbol (404 if flat).',
    inputSchema: { type: 'object', properties: { symbol: str }, required: ['symbol'] },
  },
  {
    name: 'get_orders',
    description: 'Your orders with fills. status: working, filled, canceled, expired or all.',
    inputSchema: { type: 'object', properties: { status: { ...str, enum: ['working', 'filled', 'canceled', 'expired', 'all'] }, symbol: str, limit: { ...num, maximum: 200 } } },
  },
  {
    name: 'get_order',
    description: 'Full detail of one of your orders, including fills.',
    inputSchema: { type: 'object', properties: { id: str }, required: ['id'] },
  },
  {
    name: 'place_order',
    description: 'Submit an order. Types: market (regular hours only) and limit. Whole shares. time-in-force: day (expires at the close) or gtc.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: str,
        side: { ...str, enum: ['buy', 'sell'] },
        orderType: { ...str, enum: ['market', 'limit'] },
        qty: { ...num, description: 'Whole share quantity' },
        limitPrice: num,
        tif: { ...str, enum: ['day', 'gtc'] },
      },
      required: ['symbol', 'side', 'orderType', 'qty'],
    },
  },
  {
    name: 'cancel_order',
    description: 'Cancel one of your working orders by id.',
    inputSchema: { type: 'object', properties: { id: str }, required: ['id'] },
  },
  {
    name: 'get_activities',
    description: 'Your account journal: fills, dividends, fees, margin calls and forced liquidations.',
    inputSchema: { type: 'object', properties: { limit: { ...num, maximum: 200 } } },
  },
]

async function callTool(name, args) {
  const a = args ?? {}
  switch (name) {
    case 'get_market_status': return api('GET', '/market/status')
    case 'get_calendar': return api('GET', '/market/calendar')
    case 'list_stocks': return api('GET', `/market/stocks?${new URLSearchParams(a.sector ? { sector: a.sector } : {})}`)
    case 'get_quote': return api('GET', `/market/quote?symbol=${encodeURIComponent(String(a.symbol ?? ''))}`)
    case 'get_candles': return api('GET', `/market/candles?symbol=${encodeURIComponent(a.symbol)}&interval=${encodeURIComponent(a.interval ?? '1d')}&range=${encodeURIComponent(a.range ?? '5y')}`)
    case 'get_news': return api('GET', `/market/news?${new URLSearchParams(Object.entries({ symbol: a.symbol, limit: a.limit ?? 25 }).filter(([, v]) => v != null && v !== ''))}`)
    case 'get_account': return api('GET', '/account')
    case 'get_portfolio': return api('GET', '/account/portfolio')
    case 'get_portfolio_history': return api('GET', `/account/portfolio/history?limit=${encodeURIComponent(a.limit ?? 500)}`)
    case 'get_positions': return api('GET', '/positions')
    case 'get_position': return api('GET', `/positions/${encodeURIComponent(a.symbol)}`)
    case 'get_orders': return api('GET', `/orders?${new URLSearchParams(Object.entries({ status: a.status && a.status !== 'all' ? a.status : '', symbol: a.symbol, limit: a.limit ?? 50 }).filter(([, v]) => v != null && v !== ''))}`)
    case 'get_order': return api('GET', `/orders/${encodeURIComponent(a.id)}`)
    case 'place_order': {
      const body = {}
      for (const k of ['symbol', 'side', 'orderType', 'qty', 'limitPrice', 'tif']) {
        if (a[k] !== undefined) body[k] = a[k]
      }
      return api('POST', '/orders', body)
    }
    case 'cancel_order': return api('DELETE', `/orders/${encodeURIComponent(a.id)}`)
    case 'get_activities': return api('GET', `/account/activities?limit=${encodeURIComponent(a.limit ?? 50)}`)
    default: return null
  }
}

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleMessage(msg) {
  const { id, method, params } = msg
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions:
          'Meridian Prime trading tools on live US market data. Start with get_market_status, get_quote and get_candles for market context; ' +
          'get_account shows your balances; place_order supports market and limit types in whole shares. ' +
          'Errors return structured codes such as insufficient_buying_power and market_closed.',
      })
      return
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return // notifications: no response
    case 'ping':
      if (!isNotification) reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: TOOLS })
      return
    case 'tools/call': {
      const name = String(params?.name ?? '')
      if (!TOOLS.some((t) => t.name === name)) {
        if (isNotification) return
        reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'UNKNOWN_TOOL', message: `Tool '${name}' does not exist.` } }) }], isError: true })
        return
      }
      try {
        const data = await callTool(name, params?.arguments)
        reply(id, { content: [{ type: 'text', text: JSON.stringify(data) }] })
      } catch (e) {
        const payload = e.isApiError ? e.payload : { error: { code: 'UPSTREAM_UNAVAILABLE', message: `Trading API unreachable: ${e.message}` } }
        reply(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true })
      }
      return
    }
    case 'resources/list':
      reply(id, { resources: [] })
      return
    case 'prompts/list':
      reply(id, { prompts: [] })
      return
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin, terminal: false })
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    try {
      void handleMessage(JSON.parse(line))
    } catch (e) {
      console.error('[meridian-prime] bad message:', e.message)
    }
  }
})

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
console.error(`[meridian-prime] MCP server ready — ${BASE_URL} (${TOOLS.length} tools)`)
