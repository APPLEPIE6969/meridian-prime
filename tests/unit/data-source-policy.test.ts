// Data-source policy guard — Meridian Prime runs on zero accounts, zero API
// keys, zero credit cards. Every outbound request in the shipped runtime must
// target Yahoo Finance's public, keyless endpoints (or loopback for the
// operator's own optional relay). This suite enforces the policy structurally,
// so a keyed provider, a credential header or an unknown host fails the build:
//
//   1. runtime proof  — the live provider's actual fetch calls (network
//                       stubbed, recorded payloads) carry no credentials and
//                       only hit the allowlisted Yahoo hosts;
//   2. source scan    — no URL literal outside the allowlist anywhere in the
//                       shipped runtime (src/ + mini-services/);
//   3. data-plane env hygiene — the fetch/parse layer reads no environment and
//                       only whitelisted config knobs, so credentials are
//                       structurally unable to reach the data path;
//   4. single network module — only the yahoo adapter performs network I/O;
//   5. supply chain   — no keyed market-data SDK in package.json, and the
//                       framework telemetry opt-out stays in the scripts;
//   6. secrets        — no hard-coded credential literals anywhere.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { robinhoodProvider } from '@/lib/provider/robinhood'
import { yahooMirrorProvider, yahooProvider } from '@/lib/provider/yahoo'
import { repoPath } from '@/lib/paths'

/** The only third-party hosts the runtime may ever talk to — the live
 * failover chain (Yahoo primary + query2 mirror + Robinhood venue). All
 * public and keyless; each was verified live before being allowlisted. */
const ALLOWED_DATA_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'feeds.finance.yahoo.com',
  'api.robinhood.com',
])
/** The operator's own machine (own API, optional relay, browser SSE). */
const ALLOWED_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Known market-data services that require an account/API key/credit card. */
const KEYED_PROVIDER_SDK =
  /alphavantage|finnhub|polygon|twelvedata|iexcloud|tiingo|eodhd|eodhistorical|marketstack|financialmodelingprep|intrinio|xignite|quandl|alpaca|interactivebrokers|tradier|oanda|fxcm|binance|coingecko|ccxt/i

/** Credential-shaped literals (cloud keys, tokens, OAuth client secrets). */
const SECRET_LITERAL =
  /sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}/

/** Config members the data plane may consult (all operational, none secret). */
const DATA_PLANE_CONFIG = new Set(['dataProvider', 'minuteRefresh', 'pollIntervalMs', 'failoverCooldownMs'])

const CODE_EXT = /\.(ts|tsx|mts|mjs|js)$/

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else if (CODE_EXT.test(entry.name)) yield p
  }
}

function runtimeSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const dir of ['src', 'mini-services', 'scripts']) {
    for (const file of walk(repoPath(dir))) out.push({ file, text: fs.readFileSync(file, 'utf8') })
  }
  return out
}

// ── 1. Runtime proof ─────────────────────────────────────────────────────────

const spark = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'spark-1.json'), 'utf8'))
const intraday = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-intraday.json'), 'utf8'))
const daily = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-daily.json'), 'utf8'))
const dividends = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-dividends.json'), 'utf8'))
const rss = fs.readFileSync(repoPath('tests', 'fixtures', 'news-AAPL.xml'), 'utf8')
const rhBatch = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'robinhood-batch.json'), 'utf8'))
const rhFund = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'robinhood-fund.json'), 'utf8'))

interface Call {
  url: string
  init: RequestInit | undefined
}

let calls: Call[] = []

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.includes('/v7/finance/spark')) return Promise.resolve(new Response(JSON.stringify(spark), { status: 200 }))
    if (u.includes('interval=1m')) return Promise.resolve(new Response(JSON.stringify(intraday), { status: 200 }))
    if (u.includes('events=div')) return Promise.resolve(new Response(JSON.stringify(dividends), { status: 200 }))
    if (u.includes('/v8/finance/chart')) return Promise.resolve(new Response(JSON.stringify(daily), { status: 200 }))
    if (u.includes('feeds.finance.yahoo.com')) return Promise.resolve(new Response(rss, { status: 200 }))
    if (u.includes('/quotes/?symbols=')) {
      const requested = u.split('symbols=')[1].split(',').map((s) => decodeURIComponent(s))
      const rows = rhBatch.results.filter((r: { symbol: string }) => requested.includes(r.symbol))
      return Promise.resolve(new Response(JSON.stringify({ results: rows }), { status: 200 }))
    }
    if (u.includes('/fundamentals/?symbols=')) {
      const requested = u.split('symbols=')[1].split(',').map((s) => decodeURIComponent(s))
      const pairs = rhBatch.results
        .map((r: { symbol: string }, i: number) => ({ symbol: r.symbol, fund: rhFund.results[i] }))
        .filter((p: { symbol: string }) => requested.includes(p.symbol))
      return Promise.resolve(new Response(JSON.stringify({ results: pairs.map((p: { fund: unknown }) => p.fund) }), { status: 200 }))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('data-source policy: runtime proof', () => {
  it('every live-provider request is credential-free and hits an allowlisted data host', async () => {
    // Drive every fetch path the production data plane owns: the yahoo
    // adapter (primary), its query2 mirror, and the robinhood venue.
    await yahooProvider.getQuotes(['AAPL', 'MSFT'])
    await yahooProvider.getMinuteBars('AAPL')
    await yahooProvider.getDailyHistory('AAPL')
    await yahooProvider.getDividends('AAPL')
    await yahooProvider.getNews(['AAPL', 'MSFT'], 5)
    await yahooMirrorProvider.getQuotes(['AAPL'])
    await robinhoodProvider.getQuotes(['AAPL'])

    expect(calls.length).toBeGreaterThanOrEqual(8)
    for (const call of calls) {
      const host = new URL(call.url).hostname
      expect(ALLOWED_DATA_HOSTS.has(host), `unexpected data host: ${host}`).toBe(true)

      const headers = new Headers(call.init?.headers)
      expect(headers.get('authorization')).toBeNull()
      expect(headers.get('cookie')).toBeNull()
      expect(headers.get('x-api-key')).toBeNull()
      // Exactly the two innocuous headers the adapter declares — a browser
      // User-Agent (rate-limit etiquette, not authentication) and accept.
      const names = [...headers.keys()].map((k) => k.toLowerCase()).sort()
      expect(names).toEqual(['accept', 'user-agent'])
    }
  })

  it('the fixture provider performs no network I/O at all', async () => {
    const text = fs.readFileSync(repoPath('src', 'lib', 'provider', 'fixture.ts'), 'utf8')
    expect(text).not.toMatch(/\bfetch\(/)
  })
})

// ── 2. Source scan ───────────────────────────────────────────────────────────

describe('data-source policy: source scan', () => {
  it('no shipped source references a host outside the allowlist', () => {
    const found = new Set<string>()
    for (const { file, text } of runtimeSources()) {
      for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9.[\]:-]+/g)) {
        const host = new URL(m[0]).hostname
        found.add(host)
        expect(
          ALLOWED_DATA_HOSTS.has(host) || ALLOWED_LOOPBACK_HOSTS.has(host),
          `${file} references non-allowlisted host: ${host}`,
        ).toBe(true)
      }
    }
    // Anti-rot: the scan must actually still see the data plane.
    expect([...ALLOWED_DATA_HOSTS].every((h) => found.has(h))).toBe(true)
  })

  it('no shipped source contains a credential literal', () => {
    for (const { file, text } of runtimeSources()) {
      expect(SECRET_LITERAL.test(text), `secret-looking literal in ${file}`).toBe(false)
    }
  })
})

// ── 3+4. Data-plane env hygiene & single network module ─────────────────────

describe('data-source policy: data plane hygiene', () => {
  const dataPlane = [
    ...['yahoo.ts', 'fixture.ts', 'synth.ts', 'robinhood.ts', 'chain.ts', 'http.ts'].map((f) => ({
      file: `src/lib/provider/${f}`,
    })),
    ...['quotes.ts', 'candles.ts', 'news.ts'].map((f) => ({ file: `src/lib/market/${f}` })),
  ].map(({ file }) => ({ file, text: fs.readFileSync(repoPath(...file.split('/')), 'utf8') }))

  it('the fetch/parse layer reads no environment variables', () => {
    for (const { file, text } of dataPlane) {
      expect(text.includes('process.env'), `${file} reads process.env`).toBe(false)
    }
  })

  it('the data plane only consults whitelisted operational config', () => {
    for (const { file, text } of dataPlane) {
      for (const m of text.matchAll(/cfg\(\)\.([A-Za-z0-9_]+)/g)) {
        expect(DATA_PLANE_CONFIG.has(m[1]), `${file} reads config member '${m[1]}'`).toBe(true)
      }
    }
  })

  it('only the market data adapters perform network I/O', () => {
    for (const { file, text } of dataPlane) {
      if (file.endsWith('yahoo.ts') || file.endsWith('robinhood.ts') || file.endsWith('http.ts')) continue
      expect(text.match(/\bfetch\(/), `${file} performs network I/O`).toBeNull()
    }
  })
})

// ── 5. Supply chain ──────────────────────────────────────────────────────────

describe('data-source policy: supply chain', () => {
  it('ships no keyed market-data SDK', () => {
    const pkg = JSON.parse(fs.readFileSync(repoPath('package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    expect(deps.length).toBeGreaterThan(0)
    for (const dep of deps) {
      expect(dep, `keyed-provider SDK in package.json: ${dep}`).not.toMatch(KEYED_PROVIDER_SDK)
    }
  })

  it('keeps the framework telemetry opt-out in the scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(repoPath('package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const script of ['dev', 'build', 'start']) {
      expect(pkg.scripts[script], `${script} must set NEXT_TELEMETRY_DISABLED`).toContain('NEXT_TELEMETRY_DISABLED')
    }
  })
})
