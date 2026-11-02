'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'

interface ClockInfo {
  now: string
  session: { state: string; label: string }
}

export function DeskShell({ children }: { children: React.ReactNode }) {
  const [clock, setClock] = useState<ClockInfo | null>(null)
  const [etTime, setEtTime] = useState('')
  const [search, setSearch] = useState('')
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const res = await fetch('/api/console/clock', { cache: 'no-store' })
        if (res.ok) {
          const json = await res.json()
          if (!stopped) setClock(json.data as ClockInfo)
        }
      } catch {
        // clock is cosmetic — ignore network hiccups
      }
    }
    void load()
    const timer = setInterval(load, 15_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      setEtTime(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).format(new Date()),
      )
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  const stateClass = clock
    ? `session-badge session-${clock.session.state === 'open' ? 'open' : clock.session.state.replace('_market', '')}`
    : 'session-badge'

  const onLogin = pathname === '/login'

  async function logout() {
    await fetch('/api/console/login', { method: 'DELETE' })
    router.push('/login')
    router.refresh()
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    const sym = search.trim().toUpperCase()
    if (sym.length > 0) router.push(`/symbol/${encodeURIComponent(sym)}`)
  }

  return (
    <div className="shell">
      <div className="topbar">
        <Link href="/" className="brand" style={{ color: 'inherit', textDecoration: 'none' }}>
          MERIDIAN <span className="prime">PRIME</span>
        </Link>
        <div className="clock">
          <span>{etTime} ET</span>
          <span className={stateClass}>{clock ? clock.session.label.split(' · ')[0] : '—'}</span>
        </div>
        <div className="spacer" />
        {!onLogin && (
          <>
            <form className="nav-search" onSubmit={submitSearch}>
              <input
                placeholder="SYMBOL"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Symbol lookup"
              />
            </form>
            <button className="btn" onClick={logout}>Sign out</button>
          </>
        )}
      </div>
      <main className="main">{children}</main>
      <div className="footnote">
        {clock ? clock.session.label : 'CONNECTING…'}
      </div>
    </div>
  )
}
