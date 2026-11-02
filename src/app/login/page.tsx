'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  useEffect(() => {
    // Already signed in? Straight to the desk.
    fetch('/api/console/agents', { cache: 'no-store' }).then((res) => {
      if (res.ok) router.replace('/')
    }).catch(() => {})
  }, [router])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/console/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passcode }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setError(json?.error?.message ?? 'Sign-in failed')
        return
      }
      router.push('/')
      router.refresh()
    } catch {
      setError('Network error — try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 380, margin: '9vh auto 0' }}>
      <div className="panel">
        <div className="panel-head">
          <h2>Operator sign-in</h2>
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          The desk console is for the house. Agent API keys are issued from inside.
        </p>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="passcode">Passcode</label>
            <input
              id="passcode"
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              autoFocus
              placeholder="••••••••••••"
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy || passcode.length === 0} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Enter the desk'}
          </button>
        </form>
      </div>
    </div>
  )
}
