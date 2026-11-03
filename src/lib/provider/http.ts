// Shared outbound HTTP for the live market data providers.
//
// Policy (enforced by tests/unit/data-source-policy.test.ts): keyless by
// design — a browser User-Agent for rate-limit etiquette and an accept
// header, nothing else. Retries are bounded and back off linearly on
// transient upstream failures (429 / 5xx / network errors).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT_MS = 12_000

export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, accept: 'application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`upstream ${res.status} for ${url}`)
        if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 800 * (i + 1)))
        continue
      }
      if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`)
      return res
    } catch (err) {
      lastError = err
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function fetchJsonWithRetry<T>(url: string, attempts = 3): Promise<T> {
  const res = await fetchWithRetry(url, attempts)
  return (await res.json()) as T
}

export async function fetchTextWithRetry(url: string, attempts = 3): Promise<string> {
  const res = await fetchWithRetry(url, attempts)
  return res.text()
}
