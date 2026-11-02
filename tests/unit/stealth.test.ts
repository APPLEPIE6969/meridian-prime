import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { repoPath } from '@/lib/paths'
import { resetQuoteService } from '@/lib/market/quotes'
import { resetTradingEngine } from '@/lib/engine/engine'

// ── The stealth gate ─────────────────────────────────────────────────────────
// Everything an AI agent can observe — REST responses, error strings, MCP
// tool descriptions, server instructions — must read like a live brokerage.
// No paper/simulated/fake/practice/demo vocabulary, anywhere, ever.

const BANNED = [
  /\bpaper\b/i,
  /simulat/i,
  /\bfake\b/i,
  /virtual/i,
  /\bpractice\b/i,
  /play[- ]?money/i,
  /\bdemo\b/i,
  /monopoly/i,
  /\bsandbox\b/i,
  /\bmock(ed|ing)?\b/i,
  /\bdummy\b/i,
  /\bstub(bed)?\b/i,
  /\bnot[- ]real\b/i,
  /backtest/i,
  /synthetic/i,
]

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/(?<=[^:])\/\/.*$/gm, ' ')
}

function scanForBanned(text: string, label: string): string[] {
  const hits: string[] = []
  for (const pattern of BANNED) {
    const match = text.match(pattern)
    if (match) hits.push(`${label}: /${pattern.source}/ matched "${match[0]}"`)
  }
  return hits
}

describe('stealth: agent-facing REST surface', () => {
  it('keeps banned vocabulary out of every /api/v1 route, engine and api module', () => {
    const dirs = [
      repoPath('src', 'app', 'api', 'v1'),
      repoPath('src', 'lib', 'engine'),
      repoPath('src', 'lib', 'api'),
    ]
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) files.push(full)
      }
    }
    for (const dir of dirs) walk(dir)

    expect(files.length).toBeGreaterThan(20)
    const violations: string[] = []
    for (const file of files) {
      const cleaned = stripComments(fs.readFileSync(file, 'utf8'))
      violations.push(...scanForBanned(cleaned, path.relative(repoPath(), file)))
    }
    expect(violations).toEqual([])
  })

  it('keeps banned vocabulary out of the machine-readable docs payload', async () => {
    const { GET } = await import('@/app/api/v1/docs/route')
    const res = await GET()
    const body = JSON.stringify(await res.json())
    expect(scanForBanned(body, 'docs response')).toEqual([])
  })

  it('keeps banned vocabulary out of market status and calendar payloads', async () => {
    const { GET: statusGET } = await import('@/app/api/v1/market/status/route')
    const { GET: calendarGET } = await import('@/app/api/v1/market/calendar/route')
    expect(scanForBanned(JSON.stringify(await (await statusGET()).json()), 'status')).toEqual([])
    expect(scanForBanned(JSON.stringify(await (await calendarGET()).json()), 'calendar')).toEqual([])
  })

  it('never leaks stack traces or internals in error responses', async () => {
    const { fail, handleError } = await import('@/lib/api/respond')
    const boom = handleError(new Error('secret internal path /home/z/xyz'))
    const body = JSON.stringify(await boom.json())
    expect(body).not.toContain('secret internal path')
    expect(body).toContain('internal_error')

    const res = fail(400, 'bad_request', 'oops')
    expect(res.status).toBe(400)
  })
})

describe('stealth: MCP adapter surface', () => {
  const child = spawn(process.execPath, [repoPath('src', 'mcp', 'server.mjs')], {
    env: {
      ...process.env,
      MERIDIAN_API_KEY: 'mrp_live_stealthcheck0000000000000000',
      MERIDIAN_BASE_URL: 'http://127.0.0.1:59999', // unreachable on purpose
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  afterAll(() => {
    child.kill('SIGTERM')
    resetQuoteService()
    resetTradingEngine()
  })

  it('speaks clean brokerage language in initialize, tools/list and errors', async () => {
    const lines: string[] = []
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) lines.push(line)
      }
    })

    const send = (msg: object): void => {
      child.stdin.write(JSON.stringify(msg) + '\n')
    }

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_account', arguments: {} } })
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })

    // Wait for the four replies (matched by id).
    type RpcReply = { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } }
    const byId = (id: number): RpcReply | null => {
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as RpcReply
          if (msg.id === id && (msg.result || msg.error)) return msg
        } catch {
          // partial line — ignore
        }
      }
      return null
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !(byId(1) && byId(2) && byId(3) && byId(4))) {
      await new Promise((r) => setTimeout(r, 150))
    }

    const init = byId(1)
    const tools = byId(2)
    const apiError = byId(3)
    const unknownTool = byId(4)
    expect(init).not.toBeNull()
    expect(tools).not.toBeNull()
    expect(apiError).not.toBeNull()
    expect(unknownTool).not.toBeNull()

    interface McpTool {
      name: string
      description: string
      inputSchema: { type: string }
    }
    interface McpReply {
      id: number
      result?: {
        serverInfo?: { name?: string }
        tools?: McpTool[]
        isError?: boolean
      }
      error?: { code: number; message: string }
    }

    const initReply = init as McpReply
    const toolsReply = tools as McpReply
    const apiErrorReply = apiError as McpReply
    const unknownReply = unknownTool as McpReply

    // initialize: instructions + server info
    expect(initReply.result?.serverInfo?.name).toBe('meridian-prime')
    expect(scanForBanned(JSON.stringify(initReply.result), 'mcp initialize')).toEqual([])

    // tools/list: every tool name + description
    const toolList = toolsReply.result?.tools ?? []
    expect(toolList.length).toBeGreaterThanOrEqual(15)
    for (const tool of toolList) {
      expect(tool.name).toMatch(/^[a-z_]+$/)
      expect(tool.description.length).toBeGreaterThan(15)
    }
    expect(scanForBanned(JSON.stringify(toolList), 'mcp tools')).toEqual([])

    // API error surfaces structured codes, never internal detail
    expect(apiErrorReply.result?.isError).toBe(true)
    expect(scanForBanned(JSON.stringify(apiErrorReply.result), 'mcp api error')).toEqual([])

    // unknown tool is a clean structured error
    expect(unknownReply.result?.isError).toBe(true)
    expect(JSON.stringify(unknownReply.result)).toContain('UNKNOWN_TOOL')
  }, 25_000)
})
