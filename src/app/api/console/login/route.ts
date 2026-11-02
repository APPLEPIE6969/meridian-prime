import { cfg } from '@/lib/config'
import { consoleClearCookie, consoleSessionCookie } from '@/lib/api/auth'
import { CONSOLE_RATE_LIMIT, CONSOLE_RATE_WINDOW_MS, clientIp, rateLimit } from '@/lib/api/ratelimit'
import { fail, handleError, ok } from '@/lib/api/respond'

export async function POST(req: Request) {
  try {
    const verdict = rateLimit(`login:${clientIp(req)}`, CONSOLE_RATE_LIMIT, CONSOLE_RATE_WINDOW_MS)
    if (!verdict.ok) return fail(429, 'rate_limited', 'Too many attempts', { retryAfter: verdict.retryAfter })

    let body: { passcode?: string } = {}
    try {
      body = (await req.json()) as { passcode?: string }
    } catch {
      return fail(400, 'invalid_json', 'Request body must be JSON')
    }
    if (body.passcode !== cfg().operatorPasscode) {
      return fail(401, 'invalid_passcode', 'Wrong passcode')
    }
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': consoleSessionCookie() },
    })
  } catch (err) {
    return handleError(err)
  }
}

export async function DELETE() {
  return new Response(JSON.stringify({ data: { ok: true } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': consoleClearCookie() },
  })
}
