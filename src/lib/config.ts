// Environment-backed configuration. Values are read lazily on every access so
// tests and CI can set env vars before the first call without module-load
// ordering surprises.

function envStr(key: string, fallback: string): string {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

function envInt(key: string, fallback: number): number {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

export function cfg() {
  return {
    /** Market data provider: live Yahoo Finance or the recorded-fixture provider. */
    dataProvider: envStr('MERIDIAN_DATA_PROVIDER', 'yahoo'),
    /** Quote poll cadence (ms). */
    pollIntervalMs: envInt('MERIDIAN_POLL_INTERVAL_MS', 5000),
    /** Symbols whose 1-minute series is refreshed per poll cycle (round-robin). */
    minuteRefresh: envInt('MERIDIAN_MINUTE_REFRESH', 8),
    /** Operator desk passcode for the web console. */
    operatorPasscode: envStr('MERIDIAN_OPERATOR_PASSCODE', 'meridian-desk-2026'),
    /** Optional Socket.IO relay for live console streaming. */
    relayUrl: envStr('MERIDIAN_RELAY_URL', ''),
    relayToken: envStr('MERIDIAN_RELAY_TOKEN', 'prime-relay'),
    logLevel: envStr('MERIDIAN_LOG_LEVEL', 'info'),
  }
}

// ── Execution realism constants ──────────────────────────────────────────────

/** Max share of a minute's traded volume one order may consume per poll. */
export const PARTICIPATION_RATE = 0.05

/** Square-root market-impact coefficient (fraction of ADV-notional). */
export const IMPACT_COEFF = 0.12

/** Default cash for newly created agent accounts. */
export const DEFAULT_STARTING_CASH = 1_000_000

/** Reg-T initial requirement (fraction of gross exposure). */
export const INITIAL_MARGIN = 0.5

/** Maintenance requirements: long vs short side. */
export const MAINTENANCE_LONG = 0.25
export const MAINTENANCE_SHORT = 0.3

/** Pattern day trader threshold and rolling window. */
export const PDT_EQUITY_THRESHOLD = 25_000
export const PDT_MAX_DAY_TRADES = 3
export const PDT_WINDOW_BUSINESS_DAYS = 5

/** Fees (2026 US equities). SEC activity fee and FINRA trading activity fee
 * apply to sells only; both round up to the cent. */
export const SEC_FEE_PER_MILLION = 27.8
export const TAF_PER_SHARE = 0.000166
export const TAF_CAP = 8.3

/** Spread model: max(1 cent, 1 bp of last). */
export const SPREAD_BPS = 1
export const MIN_SPREAD = 0.01

/** A "liquid" dollar-volume floor used to keep impact sane on quiet names. */
export const MIN_ADV_NOTIONAL = 5_000_000

/** Regular session length in minutes (390) — used to estimate per-minute
 * traded volume when no fresh 1-minute bars are available. */
export const SESSION_MINUTES = 390
