// Platform clock. The engine, services and routes read time exclusively
// through now() so the whole desk can be frozen or shifted for tests and
// demos. MERIDIAN_CLOCK (ISO timestamp) freezes the clock at boot — useful
// for rehearsing a session offline; the engine treats a frozen clock as the
// current session time.

let offsetMs = 0
let frozenMs: number | null = null

function applyEnvOverride(): void {
  const raw = process.env.MERIDIAN_CLOCK
  if (!raw) return
  const t = Date.parse(raw)
  if (Number.isFinite(t)) frozenMs = t
}

export function now(): Date {
  if (frozenMs === null) applyEnvOverride()
  if (frozenMs !== null) return new Date(frozenMs)
  return new Date(Date.now() + offsetMs)
}

/** The untouched wall clock — used only for logs/diagnostics. */
export function realNow(): Date {
  return new Date()
}

export function setClockOverride(opts: { frozen?: number | null; offsetMs?: number }): void {
  if (opts.frozen !== undefined) frozenMs = opts.frozen
  if (opts.offsetMs !== undefined) offsetMs = opts.offsetMs
}

export function resetClock(): void {
  frozenMs = null
  offsetMs = 0
}
