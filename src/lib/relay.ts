import { cfg } from './config'
import { log } from './log'

/**
 * Fire-and-forget push to the optional Socket.IO relay
 * (mini-services/relay). Failures are logged and swallowed by design — a
 * down relay must never take the trading path down with it.
 */
export function relayPush(event: string, payload: unknown): void {
  const url = cfg().relayUrl
  if (!url) return
  void (async () => {
    try {
      await fetch(`${url.replace(/\/$/, '')}/internal/broadcast`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-relay-token': cfg().relayToken },
        body: JSON.stringify({ event, payload }),
        signal: AbortSignal.timeout(3000),
      })
    } catch (err) {
      log('debug', 'relay push failed', { event, error: err instanceof Error ? err.message : String(err) })
    }
  })()
}
