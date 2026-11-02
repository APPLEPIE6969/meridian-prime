#!/usr/bin/env node
// E2E relay conformance: boots the Socket.IO relay, verifies token auth,
// broadcast fan-out and health reporting.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { io } from 'socket.io-client'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const PORT = Number(process.env.RELAY_TEST_PORT || 3013)
const TOKEN = 'conformance-relay-token'
const URL_BASE = `http://localhost:${PORT}`

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const relay = spawn('npx', ['tsx', 'index.ts'], {
  cwd: path.join(ROOT, 'mini-services', 'relay'),
  env: { ...process.env, RELAY_PORT: String(PORT), RELAY_TOKEN: TOKEN },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let relayLog = ''
relay.stdout.on('data', (c) => { relayLog += String(c) })
relay.stderr.on('data', (c) => { relayLog += String(c) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitHealthy(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return res
    } catch { /* not up yet */ }
    await sleep(400)
  }
  return null
}

try {
  const health = await waitHealthy()
  check('relay boots and reports health', health !== null)

  const noToken = await fetch(`${URL_BASE}/internal/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'market', payload: { quotes: [] } }),
  })
  check('broadcast without token -> 403', noToken.status === 403)

  const client = io(URL_BASE, { transports: ['websocket'], reconnection: false, timeout: 8000 })
  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no market event in time')), 12000)
    client.on('connect', async () => {
      client.on('market', (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
      const push = await fetch(`${URL_BASE}/internal/broadcast`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-relay-token': TOKEN },
        body: JSON.stringify({
          event: 'market',
          payload: { quotes: [{ symbol: 'AAPL', last: 250.05, bid: 250.03, ask: 250.07 }], at: new Date().toISOString() },
        }),
        signal: AbortSignal.timeout(5000),
      })
      check('authenticated broadcast accepted', push.status === 200)
    })
    client.on('connect_error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
  check('connected client receives the market event', received?.quotes?.[0]?.symbol === 'AAPL', JSON.stringify(received).slice(0, 120))

  const activity = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000)
    client.on('activity', (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
    void fetch(`${URL_BASE}/internal/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-token': TOKEN },
      body: JSON.stringify({ event: 'activity', payload: { kind: 'fill', message: 'Filled: BUY 5 AAPL @ 250.06' } }),
    }).catch(() => {})
  })
  check('activity events fan out too', activity?.kind === 'fill')

  client.close()

  const healthAfter = await fetch(`${URL_BASE}/health`)
  const healthBody = await healthAfter.json()
  check('health reports the client count', healthAfter.status === 200 && typeof healthBody?.clients === 'number')
} finally {
  relay.kill('SIGTERM')
  await sleep(300)
}

if (failures > 0) console.error(relayLog.slice(-500))
console.log(failures === 0 ? '\nws-relay: ALL GREEN' : `\nws-relay: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
