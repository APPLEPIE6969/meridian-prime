import { createHash } from 'node:crypto'
import type { Account } from '@prisma/client'
import { cfg } from '../config'
import { findAccountByKey } from '../engine/accounts'

/** Extract a bearer key from the Authorization header. */
export function bearerKey(req: Request): string | null {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

/** Resolve the agent account for a request, or null. */
export async function agentFromRequest(req: Request): Promise<Account | null> {
  const key = bearerKey(req)
  if (!key) return null
  return findAccountByKey(key)
}

export const DESK_COOKIE = 'mp_desk'

/** The desk session token is derived from the operator passcode; rotating
 * the passcode invalidates every console session. */
export function deskToken(): string {
  return createHash('sha256').update(cfg().operatorPasscode).digest('hex')
}

export function consoleAuthed(req: Request): boolean {
  const cookie = req.headers.get('cookie') ?? ''
  const match = cookie.match(new RegExp(`${DESK_COOKIE}=([a-f0-9]+)`))
  return match?.[1] === deskToken()
}

export function consoleSessionCookie(): string {
  return `${DESK_COOKIE}=${deskToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
}

export function consoleClearCookie(): string {
  return `${DESK_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}
