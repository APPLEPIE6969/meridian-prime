'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { desk } from '@/lib/client/api'
import { clockTime, clsFor, compact, signedUsd, usd } from '@/lib/client/format'

interface AgentRow {
  id: string
  name: string
  kind: string
  keyPreview: string
  createdAt: string
  equity: number
  cash: number
  buyingPower: number
  dayTradeCount: number
  pnlDay: number
  workingOrders: number
  lastActivity: { kind: string; message: string; ts: string } | null
}

interface MoverRow {
  symbol: string
  name: string
  last: number
  prevClose: number
  changePct: number
  dayVolume: number
}

interface Overview {
  session: { state: string; label: string }
  serverTime: string
  marketData: { quotesLive: number; universe: number; lastPollAt: string | null }
  agents: AgentRow[]
  movers: MoverRow[]
  activity: Array<{ id: string; accountId: string | null; kind: string; symbol: string | null; message: string; ts: string }>
  news: Array<{ id: string; headline: string; source: string; url: string; symbols: string[]; publishedAt: string }>
}

interface CreatedAgent {
  accountId: string
  name: string
  apiKey: string
  kind: string
  startingCash: number
}

export default function DeskPage() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [created, setCreated] = useState<CreatedAgent | null>(null)
  const [name, setName] = useState('')
  const [cash, setCash] = useState('1000000')
  const [kind, setKind] = useState('margin')
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const overview = await desk<Overview>('/api/console/overview')
      setData(overview)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      void load()
    }, 10_000)
    return () => clearInterval(timer)
  }, [load])

  async function createAgent(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    try {
      const result = await desk<CreatedAgent>('/api/console/agents', {
        method: 'POST',
        body: JSON.stringify({ name, startingCash: Number(cash), kind }),
      })
      setCreated(result)
      setShowForm(false)
      setName('')
      void load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    }
  }

  const totalEquity = data?.agents.reduce((sum, a) => sum + a.equity, 0) ?? 0

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h1>Operator desk</h1>
          <div className="muted mono" style={{ fontSize: 12 }}>
            {data ? data.session.label : 'connecting…'}
            {data?.marketData.lastPollAt ? ` · last tick ${clockTime(data.marketData.lastPollAt)}` : ''}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => { setShowForm((v) => !v); setCreated(null) }}>
          {showForm ? 'Close' : '+ New agent account'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {created && (
        <div className="notice">
          <strong>{created.name}</strong> is live — {created.kind} account, {usd(created.startingCash, 0)} buying base.
          <div style={{ marginTop: 8 }}>
            API key (shown once — copy it now): <span className="kbd">{created.apiKey}</span>
          </div>
          <div style={{ marginTop: 6 }}>
            <button className="btn" onClick={() => { void navigator.clipboard.writeText(created.apiKey) }}>Copy key</button>{' '}
            <Link href={`/agent/${created.accountId}`} className="btn">Open account</Link>
          </div>
        </div>
      )}

      {showForm && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-head"><h2>New agent account</h2></div>
          {formError && <div className="error-banner">{formError}</div>}
          <form onSubmit={createAgent} className="cols-4 grid" style={{ alignItems: 'end' }}>
            <div className="field">
              <label htmlFor="agent-name">Name</label>
              <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vega-1" required />
            </div>
            <div className="field">
              <label htmlFor="agent-cash">Starting cash ($)</label>
              <input id="agent-cash" value={cash} onChange={(e) => setCash(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="agent-kind">Account type</label>
              <select id="agent-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="margin">Margin (Reg-T)</option>
                <option value="cash">Cash</option>
              </select>
            </div>
            <button className="btn btn-primary" type="submit" disabled={name.trim().length === 0}>Open account</button>
          </form>
        </div>
      )}

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="panel stat">
          <div className="label">Agents</div>
          <div className="value">{data?.agents.length ?? '—'}</div>
          <div className="sub">{data?.agents.filter((a) => a.workingOrders > 0).length ?? 0} with working orders</div>
        </div>
        <div className="panel stat">
          <div className="label">House equity</div>
          <div className="value">{data ? usd(totalEquity, 0) : '—'}</div>
          <div className="sub">combined across accounts</div>
        </div>
        <div className="panel stat">
          <div className="label">Market data</div>
          <div className="value">{data ? `${data.marketData.quotesLive}/${data.marketData.universe}` : '—'}</div>
          <div className="sub">live quotes on the desk</div>
        </div>
        <div className="panel stat">
          <div className="label">Session</div>
          <div className="value" style={{ fontSize: 15 }}>{data?.session.state.replace('_', ' ').toUpperCase() ?? '—'}</div>
          <div className="sub">{data?.session.label.split(' · ').slice(1).join(' · ') || 'regular hours'}</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-head"><h2>Agent accounts</h2></div>
        {data && data.agents.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Type</th>
                <th className="num">Equity</th>
                <th className="num">Cash</th>
                <th className="num">Buying power</th>
                <th className="num">P&L vs start</th>
                <th className="num">Day trades</th>
                <th className="num">Working</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/agent/${a.id}`}><strong>{a.name}</strong></Link></td>
                  <td><span className="tag">{a.kind}</span></td>
                  <td className="num">{usd(a.equity)}</td>
                  <td className="num">{usd(a.cash)}</td>
                  <td className="num">{usd(a.buyingPower)}</td>
                  <td className={`num ${clsFor(a.pnlDay)}`}>{signedUsd(a.pnlDay)}</td>
                  <td className="num">{a.dayTradeCount}</td>
                  <td className="num">{a.workingOrders}</td>
                  <td className="muted" style={{ whiteSpace: 'normal', maxWidth: 340 }}>
                    {a.lastActivity ? `${a.lastActivity.message} · ${timeAgoLocal(a.lastActivity.ts)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No agent accounts yet — open one to start routing orders.</div>
        )}
      </div>

      <div className="grid cols-23">
        <div className="panel">
          <div className="panel-head"><h2>Tape — biggest movers</h2></div>
          {data && data.movers.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Last</th>
                  <th className="num">Change</th>
                  <th className="num">Volume</th>
                </tr>
              </thead>
              <tbody>
                {data.movers.map((m) => (
                  <tr key={m.symbol}>
                    <td>
                      <Link href={`/symbol/${m.symbol}`}><strong className="mono">{m.symbol}</strong></Link>{' '}
                      <span className="muted" style={{ fontSize: 11 }}>{m.name.slice(0, 28)}</span>
                    </td>
                    <td className="num">{usd(m.last)}</td>
                    <td className={`num ${clsFor(m.changePct)}`}>{signedPctLocal(m.changePct)}</td>
                    <td className="num">{compact(m.dayVolume)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">Waiting for the first quote cycle…</div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Activity</h2></div>
          <div className="activity-feed">
            {data && data.activity.length > 0 ? (
              data.activity.map((a) => (
                <div key={a.id} className="activity-item">
                  <span className="when">{clockTime(a.ts)}</span>
                  <span className={`tag ${a.kind === 'fill' ? 'tag-filled' : a.kind.includes('cancel') || a.kind.includes('expire') ? 'tag-canceled' : ''}`}>{a.kind}</span>
                  <span className="what">{a.message}</span>
                </div>
              ))
            ) : (
              <div className="empty">No activity yet.</div>
            )}
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head"><h2>News wire</h2></div>
        <div className="news-feed">
          {data && data.news.length > 0 ? (
            data.news.map((n) => (
              <div key={n.id} className="news-item">
                <div className="headline"><a href={n.url} target="_blank" rel="noreferrer">{n.headline}</a></div>
                <div className="meta">
                  <span>{n.source}</span>
                  {n.symbols.map((s) => <span key={s} className="tag">{s}</span>)}
                  <span>{timeAgoLocal(n.publishedAt)} ago</span>
                </div>
              </div>
            ))
          ) : (
            <div className="empty">Wire is quiet — headlines land as the feed refreshes.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function timeAgoLocal(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function signedPctLocal(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
}
