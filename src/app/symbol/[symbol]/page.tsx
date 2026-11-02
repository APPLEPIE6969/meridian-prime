'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { desk } from '@/lib/client/api'
import { clsFor, compact, usd } from '@/lib/client/format'
import { SymbolChart, type ChartBar } from '@/components/SymbolChart'

interface InstrumentQuote {
  symbol: string
  name: string
  sector: string
  kind: string
  exchange: string
  quote: {
    last: number
    bid: number
    ask: number
    bidSize: number
    askSize: number
    prevClose: number
    dayHigh: number
    dayLow: number
    dayVolume: number
  } | null
}

const RANGES = [
  { key: '1d', label: '1D', interval: '1m' },
  { key: '5d', label: '5D', interval: '1d' },
  { key: '1mo', label: '1M', interval: '1d' },
  { key: '6mo', label: '6M', interval: '1d' },
  { key: '1y', label: '1Y', interval: '1d' },
  { key: '5y', label: '5Y', interval: '1d' },
] as const

export default function SymbolPage() {
  const params = useParams<{ symbol: string }>()
  const symbol = (params.symbol ?? '').toUpperCase()
  const [instrument, setInstrument] = useState<InstrumentQuote | null>(null)
  const [bars, setBars] = useState<ChartBar[]>([])
  const [rangeKey, setRangeKey] = useState<string>('6mo')
  const [error, setError] = useState<string | null>(null)

  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[4]

  const loadQuote = useCallback(async () => {
    try {
      const row = await desk<InstrumentQuote>(`/api/console/quote?symbol=${encodeURIComponent(symbol)}`)
      setInstrument(row)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [symbol])

  const loadCandles = useCallback(async () => {
    try {
      const res = await desk<{ bars: ChartBar[] }>(`/api/console/candles?symbol=${encodeURIComponent(symbol)}&interval=${range.interval}&range=${range.key}`)
      setBars(res.bars)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [symbol, range])

  useEffect(() => {
    void loadQuote()
    const timer = setInterval(() => {
      void loadQuote()
    }, 10_000)
    return () => clearInterval(timer)
  }, [loadQuote])

  useEffect(() => {
    void loadCandles()
  }, [loadCandles])

  const q = instrument?.quote
  const change = q ? q.last - q.prevClose : 0
  const changePct = q && q.prevClose > 0 ? (change / q.prevClose) * 100 : 0

  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        <Link href="/" className="muted" style={{ fontSize: 12 }}>← desk</Link>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h1 className="mono">{symbol}</h1>
        <span style={{ color: 'var(--muted)' }}>{instrument?.name ?? ''}</span>
        {instrument && <span className="tag">{instrument.sector}</span>}
        {instrument && <span className="tag">{instrument.exchange}</span>}
        {q && (
          <>
            <span className="mono" style={{ fontSize: 20 }}>{usd(q.last)}</span>
            <span className={`mono ${clsFor(change)}`} style={{ fontSize: 14 }}>
              {change >= 0 ? '+' : ''}{usd(change)} ({signedPctLocal(changePct)})
            </span>
          </>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {q && (
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <div className="panel stat">
            <div className="label">Bid / Ask</div>
            <div className="value" style={{ fontSize: 16 }}>
              {usd(q.bid)} × {q.bidSize} <span className="muted">/</span> {usd(q.ask)} × {q.askSize}
            </div>
            <div className="sub">prev close {usd(q.prevClose)}</div>
          </div>
          <div className="panel stat">
            <div className="label">Day range</div>
            <div className="value" style={{ fontSize: 16 }}>{usd(q.dayLow)} — {usd(q.dayHigh)}</div>
            <div className="sub">
              last {(Math.abs(q.last - q.dayLow) < 0.005 ? 'at low' : q.last >= q.dayHigh - 0.005 ? 'at high' : 'mid-range').toUpperCase()}
            </div>
          </div>
          <div className="panel stat">
            <div className="label">Volume</div>
            <div className="value">{compact(q.dayVolume)}</div>
            <div className="sub">shares traded today</div>
          </div>
          <div className="panel stat">
            <div className="label">Security type</div>
            <div className="value" style={{ fontSize: 16 }}>{instrument?.kind === 'etf' ? 'ETF' : 'COMMON STOCK'}</div>
            <div className="sub">{instrument?.sector}</div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Price history</h2>
          <div className="chart-toggle">
            {RANGES.map((r) => (
              <button key={r.key} className={r.key === rangeKey ? 'active' : ''} onClick={() => setRangeKey(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {bars.length > 0 ? (
          <SymbolChart bars={bars} />
        ) : (
          <div className="empty">Loading price history…</div>
        )}
      </div>

      <SymbolNews symbol={symbol} />
    </div>
  )
}

function signedPctLocal(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
}

function SymbolNews({ symbol }: { symbol: string }) {
  const [news, setNews] = useState<Array<{ id: string; headline: string; source: string; url: string; publishedAt: string }>>([])

  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const res = await desk<{ headlines: typeof news }>(`/api/console/news-wire?symbol=${encodeURIComponent(symbol)}`)
        if (!stopped) setNews(res.headlines)
      } catch {
        // news panel is best-effort on the symbol page
      }
    }
    void load()
    const timer = setInterval(load, 60_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [symbol])

  if (news.length === 0) return null
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-head"><h2>Headlines — {symbol}</h2></div>
      <div className="news-feed" style={{ maxHeight: 340 }}>
        {news.map((n) => (
          <div key={n.id} className="news-item">
            <div className="headline"><a href={n.url} target="_blank" rel="noreferrer">{n.headline}</a></div>
            <div className="meta"><span>{n.source}</span><span>{n.publishedAt.slice(0, 16).replace('T', ' ')}Z</span></div>
          </div>
        ))}
      </div>
    </div>
  )
}
