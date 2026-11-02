// Decimal-safe money helpers. Balances live as float dollars; every write
// boundary rounds to the correct precision so ledger arithmetic stays exact
// to the cent over thousands of operations.

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000
}

/** Regulatory fees round UP to the cent (SEC / FINRA convention). */
export function roundUp2(n: number): number {
  return Math.ceil((n - 1e-9) * 100) / 100
}

export function addMoney(a: number, b: number): number {
  return round2(a + b)
}

export function subMoney(a: number, b: number): number {
  return round2(a - b)
}

export function notional(qty: number, price: number): number {
  return round2(qty * price)
}

export function isBuySide(side: string): boolean {
  return side === 'buy'
}

export function signedQty(side: string, qty: number): number {
  return side === 'buy' ? qty : -qty
}

export function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`
}
