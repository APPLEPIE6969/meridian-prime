// Regulatory fee schedule — US equities, 2026 rates.
//
// Sells carry the SEC activity fee (per dollar of sale proceeds) and the
// FINRA trading activity fee (per share, capped); both round UP to the cent.
// Commission is zero (online equities commission schedule).

import { round2, roundUp2 } from '../money'
import { SEC_FEE_PER_MILLION, TAF_CAP, TAF_PER_SHARE } from '../config'

export interface FeeBreakdown {
  commission: number
  sec: number
  taf: number
  total: number
}

export function computeFees(side: string, qty: number, price: number): FeeBreakdown {
  let sec = 0
  let taf = 0
  if (side === 'sell') {
    sec = roundUp2((qty * price * SEC_FEE_PER_MILLION) / 1_000_000)
    taf = roundUp2(Math.min(TAF_CAP, qty * TAF_PER_SHARE))
  }
  const commission = 0
  return { commission, sec, taf, total: round2(commission + sec + taf) }
}
