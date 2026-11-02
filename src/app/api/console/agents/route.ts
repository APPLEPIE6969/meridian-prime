import { consoleAuthed } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { createAgent } from '@/lib/engine/accounts'
import { db } from '@/lib/db'
import { DEFAULT_STARTING_CASH } from '@/lib/config'

export async function GET(req: Request) {
  try {
    if (!consoleAuthed(req)) return fail(401, 'unauthorized', 'Operator session required')
    const accounts = await db().account.findMany({ orderBy: { createdAt: 'asc' } })
    return ok({
      count: accounts.length,
      agents: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        keyPreview: a.keyPreview,
        startingCash: a.startingCash,
        createdAt: a.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

export async function POST(req: Request) {
  try {
    if (!consoleAuthed(req)) return fail(401, 'unauthorized', 'Operator session required')
    let body: { name?: string; startingCash?: number; kind?: string } = {}
    try {
      body = (await req.json()) as typeof body
    } catch {
      return fail(400, 'invalid_json', 'Request body must be JSON')
    }
    const name = String(body.name ?? '').trim()
    if (name.length < 1 || name.length > 60) return fail(400, 'invalid_name', 'Agent name must be 1-60 characters')
    const existing = await db().account.findUnique({ where: { name } })
    if (existing) return fail(409, 'name_taken', 'An agent with that name already exists')

    const startingCash = body.startingCash === undefined ? DEFAULT_STARTING_CASH : Number(body.startingCash)
    if (!Number.isFinite(startingCash) || startingCash <= 0) {
      return fail(400, 'invalid_starting_cash', 'startingCash must be a positive number')
    }
    const kind = body.kind === 'cash' ? 'cash' : 'margin'
    const credentials = await createAgent(name, { startingCash, kind })
    return ok({ ...credentials, note: 'The API key is shown exactly once — store it now.' }, 201)
  } catch (err) {
    return handleError(err)
  }
}
