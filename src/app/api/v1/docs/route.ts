import { ok } from '@/lib/api/respond'

export async function GET() {
  return ok({
    name: 'Meridian Prime trading API',
    version: '1.0.0',
    auth: 'Authorization: Bearer <api key>',
    rateLimit: '120 requests/min per key',
    endpoints: {
      'GET /api/v1/account': 'Account state: cash, margin, buying power, equity, day trades',
      'GET /api/v1/account/portfolio': 'Positions with market values and P&L',
      'GET /api/v1/account/portfolio/history?limit=': 'Equity curve snapshots',
      'GET /api/v1/account/activities?limit=': 'Activity journal (orders, fills, dividends, margin calls)',
      'GET /api/v1/orders?status=&symbol=&limit=': 'Order list with fills',
      'POST /api/v1/orders': 'Place order { symbol, side, orderType, qty, limitPrice?, tif? }',
      'GET /api/v1/orders/{id}': 'Order detail with fills',
      'DELETE /api/v1/orders/{id}': 'Cancel a working order',
      'GET /api/v1/positions': 'Open positions',
      'GET /api/v1/positions/{symbol}': 'Position detail',
      'GET /api/v1/market/status': 'Session state and market data health (public)',
      'GET /api/v1/market/calendar': 'Trading calendar: hours, early closes, holidays (public)',
      'GET /api/v1/market/quote?symbol=': 'Top-of-book quote',
      'GET /api/v1/market/stocks?sector=': 'Tradable universe with live quotes',
      'GET /api/v1/market/stocks/{symbol}': 'Instrument detail with 52-week range',
      'GET /api/v1/market/candles?symbol=&interval=1d|1m&range=': 'OHLCV bars',
      'GET /api/v1/market/news?symbol=&limit=': 'Headlines',
    },
    orderRules: {
      orderTypes: ['market', 'limit'],
      tif: ['day', 'gtc'],
      marketOrders: 'regular hours only',
      dayOrders: 'expire at the session close',
      fills: 'against the live book, capped by participation, with size-based impact',
      settlement: 'T+1',
      margin: 'Reg-T 50% initial / 25% long / 30% short maintenance; forced liquidations below maintenance',
      pdt: '3 day trades per 5 business days under $25,000 equity',
    },
  })
}
