import { log } from '../log'

/** Success envelope: { data }. */
export function ok(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json({ data }, { status, headers })
}

/** Error envelope: { error: { code, message } }. Agent-facing failures never
 * leak stack traces or internals. */
export function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
  return Response.json({ error: { code, message, ...(extra ?? {}) } }, { status })
}

export function handleError(err: unknown): Response {
  // Structural OrderError detection, not instanceof: the standalone build
  // can hold two module copies (instrumentation graph vs route graph), and
  // `instanceof` across bundle-split classes always fails.
  if (
    err instanceof Error &&
    err.name === 'OrderError' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { status?: unknown }).status === 'number'
  ) {
    const orderError = err as unknown as { code: string; status: number; message: string }
    return fail(orderError.status, orderError.code, orderError.message)
  }
  log('error', 'unhandled route error', {
    error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
  })
  return fail(500, 'internal_error', 'Internal error')
}
