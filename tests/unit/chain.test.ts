// Failover chain — walk order, cooldown skip, automatic fail-back and the
// all-sources-down surface. Uses fake timers so the providers' internal
// retry backoffs resolve deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chainedProvider, dataHealth, resetChainHealth } from '@/lib/provider/chain'
import { activeProvider } from '@/lib/provider'
import { repoPath } from '@/lib/paths'
import fs from 'node:fs'

const spark = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'spark-1.json'), 'utf8'))
const intraday = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-intraday.json'), 'utf8'))
const daily = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-daily.json'), 'utf8'))
const dividends = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-dividends.json'), 'utf8'))
const rss = fs.readFileSync(repoPath('tests', 'fixtures', 'news-AAPL.xml'), 'utf8')
const rhBatch = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'robinhood-batch.json'), 'utf8'))
const rhFund = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'robinhood-fund.json'), 'utf8'))

const Y1 = 'query1.finance.yahoo.com'
const Y2 = 'query2.finance.yahoo.com'
const RH = 'api.robinhood.com'

let failHosts: Set<string>
let hosts: string[]

function respond(u: string): Response {
  if (u.includes('/v7/finance/spark')) return new Response(JSON.stringify(spark), { status: 200 })
  if (u.includes('interval=1m')) return new Response(JSON.stringify(intraday), { status: 200 })
  if (u.includes('events=div')) return new Response(JSON.stringify(dividends), { status: 200 })
  if (u.includes('/v8/finance/chart')) return new Response(JSON.stringify(daily), { status: 200 })
  if (u.includes('feeds.finance.yahoo.com')) return new Response(rss, { status: 200 })
  if (u.includes('/quotes/?symbols=')) {
    const requested = u.split('symbols=')[1].split(',').map((s) => decodeURIComponent(s))
    const rows = rhBatch.results.filter((r: { symbol: string }) => requested.includes(r.symbol))
    return new Response(JSON.stringify({ results: rows }), { status: 200 })
  }
  if (u.includes('/fundamentals/?symbols=')) {
    const requested = u.split('symbols=')[1].split(',').map((s) => decodeURIComponent(s))
    const pairs = rhBatch.results
      .map((r: { symbol: string }, i: number) => ({ symbol: r.symbol, fund: rhFund.results[i] }))
      .filter((p: { symbol: string }) => requested.includes(p.symbol))
    return new Response(JSON.stringify({ results: pairs.map((p: { fund: unknown }) => p.fund) }), { status: 200 })
  }
  return new Response('nope', { status: 404 })
}

beforeEach(() => {
  resetChainHealth()
  process.env.MERIDIAN_DATA_PROVIDER = 'yahoo'
  failHosts = new Set()
  hosts = []
  vi.stubGlobal('fetch', (url: string | URL) => {
    const u = String(url)
    hosts.push(new URL(u).host)
    if (failHosts.has(new URL(u).host)) return Promise.resolve(new Response('down', { status: 500 }))
    return Promise.resolve(respond(u))
  })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetChainHealth()
  process.env.MERIDIAN_DATA_PROVIDER = 'fixture'
})

/** Resolve the providers' internal retry backoffs under fake timers. */
async function drain(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 400) await vi.advanceTimersByTimeAsync(400)
}

function source(name: string) {
  return dataHealth().sources.find((s) => s.name === name)!
}

describe('live data failover chain', () => {
  it('walks to the mirror when the primary edge fails', async () => {
    failHosts.add(Y1)
    const pending = chainedProvider.getQuotes(['AAPL', 'MSFT'])
    await drain(6000)
    const quotes = await pending
    expect(quotes.length).toBe(16) // served by the mirror's spark payload
    expect(dataHealth().active).toBe('yahoo-mirror')
    expect(hosts.every((h) => h === Y1 || h === Y2)).toBe(true) // robinhood never reached
    expect(source('yahoo').failures).toBe(1)
    expect(source('yahoo').lastError).toContain('upstream 500')
    expect(source('yahoo').lastSuccessAt).toBeNull()
    expect(source('yahoo').cooldownUntil).toBeGreaterThan(Date.now())
    expect(source('yahoo-mirror').failures).toBe(0)
    expect(source('yahoo-mirror').lastSuccessAt).not.toBeNull()
  })

  it('skips a cooling-down source and fails back when the cooldown expires', async () => {
    failHosts.add(Y1)
    const first = chainedProvider.getQuotes(['AAPL'])
    await drain(6000)
    await first

    failHosts.delete(Y1)
    hosts = []
    const second = chainedProvider.getQuotes(['AAPL'])
    await drain(2000)
    await second
    expect(hosts.every((h) => h === Y2)).toBe(true) // primary probed zero times

    await vi.advanceTimersByTimeAsync(61_000) // cooldown expires
    hosts = []
    const third = chainedProvider.getQuotes(['AAPL'])
    await drain(2000)
    await third
    expect(hosts[0]).toBe(Y1) // fail-back probes the primary first
    expect(dataHealth().active).toBe('yahoo')
    expect(source('yahoo').failures).toBe(0) // success clears the streak
    expect(source('yahoo').lastError).toBeNull()
  })

  it('lands on the independent venue when both yahoo edges are down', async () => {
    failHosts.add(Y1)
    failHosts.add(Y2)
    const pending = chainedProvider.getQuotes(['AAPL', 'MSFT'])
    await drain(12000)
    const quotes = await pending
    expect(dataHealth().active).toBe('robinhood')
    const aapl = quotes.find((q) => q.symbol === 'AAPL')!
    expect(aapl.bid).toBeGreaterThan(0)
    expect(aapl.dayVolume).toBeGreaterThan(0) // hydrated from fundamentals
    expect(hosts).toContain(RH)
  })

  it('throws only after every source fails', async () => {
    failHosts.add(Y1)
    failHosts.add(Y2)
    failHosts.add(RH)
    // Attach the rejection handler before draining, so the walk's failure
    // never sits unhandled while the backoffs resolve.
    const expecter = expect(chainedProvider.getQuotes(['AAPL'])).rejects.toThrow('upstream 500')
    await drain(15000)
    await expecter
    expect(dataHealth().sources.map((s) => s.failures)).toEqual([1, 1, 1])
  })

  it('serves every capability from the healthy head of the chain', async () => {
    expect(await chainedProvider.getQuote('AAPL')).not.toBeNull()
    expect((await chainedProvider.getMinuteBars('AAPL')).length).toBeGreaterThan(100)
    expect((await chainedProvider.getDailyHistory('AAPL', '5y')).length).toBeGreaterThan(1000)
    expect((await chainedProvider.getDividends('AAPL', '6mo')).length).toBeGreaterThan(0)
    expect((await chainedProvider.getNews(['AAPL'], 5)).length).toBeGreaterThan(0)
    expect(dataHealth().active).toBe('yahoo')
  })

  it('reports health and resets cleanly', () => {
    expect(dataHealth().active).toBeNull()
    expect(dataHealth().sources.map((s) => s.name)).toEqual(['yahoo', 'yahoo-mirror', 'robinhood'])
    resetChainHealth()
    expect(dataHealth().sources).toHaveLength(3) // lazily rebuilt, empty state
    expect(dataHealth().active).toBeNull()
  })

  it('registry: live mode means the chain, fixture mode bypasses it', () => {
    process.env.MERIDIAN_DATA_PROVIDER = 'yahoo'
    expect(activeProvider().name).toBe('live-chain')
    process.env.MERIDIAN_DATA_PROVIDER = 'fixture'
    expect(activeProvider().name).toBe('fixture')
  })

  it('status route surfaces the serving source and per-source health', async () => {
    await chainedProvider.getQuotes(['AAPL'])
    const { GET } = await import('@/app/api/v1/market/status/route')
    const body = (await (await GET()).json()) as { data: { marketData: { provider: string; sources: unknown[] } } }
    expect(body.data.marketData.provider).toBe('yahoo') // the active source
    expect(body.data.marketData.sources).toHaveLength(3)

    resetChainHealth()
    process.env.MERIDIAN_DATA_PROVIDER = 'yahoo'
    const fresh = (await (await GET()).json()) as { data: { marketData: { provider: string } } }
    expect(fresh.data.marketData.provider).toBe('live') // nothing served yet
  })
})
