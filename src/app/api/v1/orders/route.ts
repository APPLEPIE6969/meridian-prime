import { agentFromRequest } from '@/lib/api/auth'
import { fail, handleError, ok } from '@/lib/api/respond'
import { tradingEngine } from '@/lib/engine/engine'

function serializeOrder(order: {
  id: string
  symbol: string
  side: string
  orderType: string
  qty: number
  limitPrice: number | null
  tif: string
  status: string
  filledQty: number
  avgFillPrice: number | null
  rejectReason: string | null
  createdAt: Date
  updatedAt: Date
  expiresAt: Date | null
  fills?: Array<{ id: string; qty: number; price: number; fees: number; ts: Date }>
}) {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    orderType: order.orderType,
    qty: order.qty,
    limitPrice: order.limitPrice,
    tif: order.tif,
    status: order.status,
    filledQty: order.filledQty,
    avgFillPrice: order.avgFillPrice,
    rejectReason: order.rejectReason,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    expiresAt: order.expiresAt?.toISOString() ?? null,
    fills: (order.fills ?? []).map((f) => ({ id: f.id, qty: f.qty, price: f.price, fees: f.fees, ts: f.ts.toISOString() })),
  }
}

export async function GET(req: Request) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    const url = new URL(req.url)
    const orders = await tradingEngine().listOrders(agent.id, {
      status: url.searchParams.get('status') ?? undefined,
      symbol: url.searchParams.get('symbol') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 50) || 50,
    })
    return ok({ count: orders.length, orders: orders.map(serializeOrder) })
  } catch (err) {
    return handleError(err)
  }
}

export async function POST(req: Request) {
  try {
    const agent = await agentFromRequest(req)
    if (!agent) return fail(401, 'unauthorized', 'Provide a valid API key as a bearer token')

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return fail(400, 'invalid_json', 'Request body must be JSON')
    }
    const input = body as Record<string, unknown>
    const order = await tradingEngine().placeOrder(agent.id, {
      symbol: String(input.symbol ?? ''),
      side: String(input.side ?? ''),
      orderType: String(input.orderType ?? ''),
      qty: Number(input.qty),
      limitPrice: input.limitPrice === undefined || input.limitPrice === null ? null : Number(input.limitPrice),
      tif: input.tif === undefined || input.tif === null ? undefined : String(input.tif),
    })
    return ok(serializeOrder(order as never), 201)
  } catch (err) {
    return handleError(err)
  }
}
