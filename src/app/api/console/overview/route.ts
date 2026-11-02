import { consoleAuthed } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { sessionInfo } from '@/lib/calendar'
import { now } from '@/lib/clock'
import { quoteService } from '@/lib/market/quotes'
import { newsWire } from '@/lib/market/news'
import { tradingEngine } from '@/lib/engine/engine'
import { db } from '@/lib/db'
import { UNIVERSE } from '@/lib/universe'

export async function GET(req: Request) {
  try {
    if (!consoleAuthed(req)) return fail(401, 'unauthorized', 'Operator session required')

    const session = sessionInfo(now())
    const engine = tradingEngine()
    const qs = quoteService()
    const accounts = await db().account.findMany({ orderBy: { createdAt: 'asc' } })

    interface AgentRow {
      id: string
      name: string
      kind: string
      keyPreview: string
      createdAt: string
      equity: number
      cash: number
      buyingPower: number
      dayTradeCount: number
      pnlDay: number
      workingOrders: number
      lastActivity: { kind: string; message: string; ts: string } | null
    }
    const agents: AgentRow[] = []
    for (const account of accounts) {
      const metrics = await engine.metrics(account.id)
      if (!metrics) continue
      const [working, recent] = await Promise.all([
        db().order.count({ where: { accountId: account.id, status: { in: ['working', 'partially_filled'] } } }),
        db().activity.findFirst({ where: { accountId: account.id }, orderBy: { ts: 'desc' } }),
      ])
      agents.push({
        id: account.id,
        name: account.name,
        kind: account.kind,
        keyPreview: account.keyPreview,
        createdAt: account.createdAt.toISOString(),
        equity: metrics.equity,
        cash: metrics.cash,
        buyingPower: metrics.buyingPower,
        dayTradeCount: metrics.dayTradeCount,
        pnlDay: Math.round((metrics.equity - account.startingCash) * 100) / 100,
        workingOrders: working,
        lastActivity: recent
          ? { kind: recent.kind, message: recent.message, ts: recent.ts.toISOString() }
          : null,
      })
    }

    const movers = UNIVERSE.map((i) => ({ symbol: i.symbol, name: i.name, quote: qs.getQuote(i.symbol) }))
      .filter((row) => row.quote !== null)
      .map((row) => ({
        symbol: row.symbol,
        name: row.name,
        last: row.quote!.last,
        prevClose: row.quote!.prevClose,
        changePct: row.quote!.prevClose > 0 ? Math.round(((row.quote!.last - row.quote!.prevClose) / row.quote!.prevClose) * 10000) / 100 : 0,
        dayVolume: row.quote!.dayVolume,
      }))
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, 10)

    const [activity, headlines] = await Promise.all([
      db().activity.findMany({ orderBy: { ts: 'desc' }, take: 30 }),
      newsWire().latest({ limit: 12 }),
    ])

    return ok({
      session: {
        state: session.state,
        label: session.label,
        earlyClose: session.earlyClose,
        nextOpen: session.nextOpen?.toISOString() ?? null,
        nextClose: session.nextClose?.toISOString() ?? null,
      },
      serverTime: now().toISOString(),
      marketData: { quotesLive: qs.quoteCount(), universe: UNIVERSE.length, lastPollAt: qs.lastPollAt ? new Date(qs.lastPollAt).toISOString() : null },
      agents,
      movers,
      activity: activity.map((a) => ({
        id: a.id,
        accountId: a.accountId,
        kind: a.kind,
        symbol: a.symbol,
        message: a.message,
        ts: a.ts.toISOString(),
      })),
      news: headlines,
    })
  } catch (err) {
    return handleError(err)
  }
}
