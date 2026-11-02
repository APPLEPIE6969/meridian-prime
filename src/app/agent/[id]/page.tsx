'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { desk } from '@/lib/client/api'
import { clockTime, clsFor, dayTime, signedUsd, usd } from '@/lib/client/format'

interface AgentDetail {
  account: { id: string; name: string; kind: string; keyPreview: string; startingCash: number; createdAt: string }
  metrics: {
    cash: number
    settledCash: number
    equity: number
    longMarketValue: number
    shortMarketValue: number
    buyingPower: number
    maintenanceExcess: number
    dayTradeCount: number
    dayTradesRemaining: number
  }
  positions: Array<{ symbol: string; qty: number; avgPrice: number; last: number; marketValue: number; unrealizedPnl: number; realizedPnl: number }>
  orders: Array<{ id: string; symbol: string; side: string; orderType: string; qty: number; limitPrice: number | null; tif: string; status: string; filledQty: number; avgFillPrice: number | null; createdAt: string }>
  fills: Array<{ id: string; orderId: string; symbol: string; side: string; qty: number; price: number; fees: number; ts: string }>
  activities: Array<{ id: string; kind: string; symbol: string | null; message: string; ts: string }>
  equityCurve: Array<{ ts: string; equity: number }>
}

export default function AgentPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [data, setData] = useState<AgentDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const detail = await desk<AgentDetail>(`/api/console/agents/${id}`)
      setData(detail)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [id])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      void load()
    }, 8_000)
    return () => clearInterval(timer)
  }, [load])

  if (error) return <div className="error-banner">{error}</div>
  if (!data) return <div className="muted">Loading account…</div>

  const pnl = data.metrics.equity - data.account.startingCash

  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        <Link href="/" className="muted" style={{ fontSize: 12 }}>← desk</Link>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
        <h1>{data.account.name}</h1>
        <span className="tag">{data.account.kind} account</span>
        <span className="tag">{data.account.keyPreview}</span>
        <span className="muted mono" style={{ fontSize: 12 }}>opened {dayTime(data.account.createdAt)}</span>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="panel stat">
          <div className="label">Equity</div>
          <div className="value">{usd(data.metrics.equity)}</div>
          <div className={`sub ${clsFor(pnl)}`}>{signedUsd(pnl)} vs {usd(data.account.startingCash, 0)} start</div>
        </div>
        <div className="panel stat">
          <div className="label">Cash / settled</div>
          <div className="value">{usd(data.metrics.cash)}</div>
          <div className="sub">settled {usd(data.metrics.settledCash)}</div>
        </div>
        <div className="panel stat">
          <div className="label">Buying power</div>
          <div className="value">{usd(data.metrics.buyingPower)}</div>
          <div className="sub">LMV {usd(data.metrics.longMarketValue, 0)} · SMV {usd(data.metrics.shortMarketValue, 0)}</div>
        </div>
        <div className="panel stat">
          <div className="label">Margin / PDT</div>
          <div className="value" style={{ fontSize: 15 }}>
            {data.metrics.maintenanceExcess >= 0 ? 'ABOVE MAINTENANCE' : 'MARGIN CALL'}
          </div>
          <div className="sub">
            excess {usd(data.metrics.maintenanceExcess, 0)} · {data.metrics.dayTradeCount}/3 day trades ({data.metrics.dayTradesRemaining} left)
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-head"><h2>Positions</h2></div>
        {data.positions.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num">Qty</th>
                <th className="num">Avg price</th>
                <th className="num">Last</th>
                <th className="num">Market value</th>
                <th className="num">Unrealized P&L</th>
                <th className="num">Realized P&L</th>
              </tr>
            </thead>
            <tbody>
              {data.positions.map((p) => (
                <tr key={p.symbol}>
                  <td><Link href={`/symbol/${p.symbol}`}><strong className="mono">{p.symbol}</strong></Link></td>
                  <td className="num">{p.qty}</td>
                  <td className="num">{usd(p.avgPrice)}</td>
                  <td className="num">{usd(p.last)}</td>
                  <td className="num">{usd(p.marketValue)}</td>
                  <td className={`num ${clsFor(p.unrealizedPnl)}`}>{signedUsd(p.unrealizedPnl)}</td>
                  <td className={`num ${clsFor(p.realizedPnl)}`}>{signedUsd(p.realizedPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">Flat — no open positions.</div>
        )}
      </div>

      <div className="grid cols-2">
        <div className="panel">
          <div className="panel-head"><h2>Orders</h2></div>
          {data.orders.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Placed</th>
                  <th>Side</th>
                  <th>Symbol</th>
                  <th className="num">Qty</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th className="num">Avg fill</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="muted">{clockTime(o.createdAt)}</td>
                    <td><span className={`tag tag-${o.side}`}>{o.side.toUpperCase()}</span></td>
                    <td><strong className="mono">{o.symbol}</strong></td>
                    <td className="num">{o.filledQty}/{o.qty}</td>
                    <td className="muted">{o.orderType}{o.limitPrice ? ` @ ${usd(o.limitPrice)}` : ''} · {o.tif}</td>
                    <td><span className={`tag tag-${o.status}`}>{o.status}</span></td>
                    <td className="num">{o.avgFillPrice ? usd(o.avgFillPrice) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No orders yet.</div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Fills</h2></div>
          {data.fills.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Side</th>
                  <th>Symbol</th>
                  <th className="num">Qty</th>
                  <th className="num">Price</th>
                  <th className="num">Fees</th>
                </tr>
              </thead>
              <tbody>
                {data.fills.map((f) => (
                  <tr key={f.id}>
                    <td className="muted">{clockTime(f.ts)}</td>
                    <td><span className={`tag tag-${f.side}`}>{f.side.toUpperCase()}</span></td>
                    <td><strong className="mono">{f.symbol}</strong></td>
                    <td className="num">{f.qty}</td>
                    <td className="num">{usd(f.price)}</td>
                    <td className="num muted">{usd(f.fees)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No fills yet.</div>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head"><h2>Account journal</h2></div>
        <div className="activity-feed" style={{ maxHeight: 380 }}>
          {data.activities.map((a) => (
            <div key={a.id} className="activity-item">
              <span className="when">{dayTime(a.ts)}</span>
              <span className="tag">{a.kind}</span>
              <span className="what">{a.message}</span>
            </div>
          ))}
          {data.activities.length === 0 && <div className="empty">Nothing on the journal yet.</div>}
        </div>
      </div>

      {data.equityCurve.length > 1 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head"><h2>Equity curve</h2></div>
          <EquitySpark points={data.equityCurve.map((p) => p.equity)} />
        </div>
      )}
    </div>
  )
}

function EquitySpark({ points }: { points: number[] }) {
  const w = 1000
  const h = 70
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const step = w / Math.max(1, points.length - 1)
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((p - min) / span) * (h - 8) - 4).toFixed(1)}`)
    .join(' ')
  const up = points[points.length - 1] >= points[0]
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height: 70 }}>
      <path d={path} fill="none" stroke={up ? '#2fbf71' : '#ef5350'} strokeWidth={1.6} />
    </svg>
  )
}
