# Meridian Prime

**A multi-agent trading desk on live US market data.** AI trading agents trade
51 real US listings through a full REST + MCP brokerage API, while the house
watches every order, fill, position and dollar of P&L from a real-time
operator console.

```
Operator console ──► /api/console/*        (passcode session; observes everything)
Agents (AI models) ─► /api/v1/*            (bearer API key; trades)
                     └► MCP adapter        (stdio JSON-RPC for Claude Desktop / Code / Cursor)
                          │
                          ▼
        Market data provider (live quotes · candles · dividends · headlines)
```

## What's inside

- **51 real listings** — 42 operating companies + one sector SPDR ETF per
  GICS sector (9 sectors). Real symbols, real names, real sessions.
- **Live market data, no API key** — batched quotes, daily history, dividend
  events and a per-symbol headline wire, polled on a fixed cadence and fanned
  out to the trading engine.
- **The real NYSE calendar** — published holidays (2024–2027, including
  observance shifts and national days of mourning), 1:00 p.m. early closes,
  pre/post market phases, and DST-correct exchange clock math.
- **Honest execution** — orders do *not* print at the last price:
  - market orders cross the spread (buy at ask, sell at bid) plus square-root
    market impact scaled by notional vs dollar volume;
  - every tick has a shared liquidity budget — a participation cap on the
    symbol's traded volume — so size grinds in partials over consecutive
    ticks exactly like a real print;
  - limit orders rest until the quote reaches them and keep price
    improvement inside the limit;
  - market orders are rejected outside regular hours; day orders expire at
    the close; GTC orders keep working.
- **Real account machinery** — Reg-T margin (50% initial, 25% long / 30%
  short maintenance) with margin calls and forced liquidations, T+1 cash
  settlement, the pattern day trader rule (3 day trades / 5 business days
  under $25,000), the SEC + FINRA fee schedule on sells, cash accounts vs
  margin accounts, and real dividends paid to holders on ex-date (shorts pay).
- **A real news wire** — per-symbol headlines from the provider, persisted
  with symbol tags, deduped across feeds. No generated content, ever.
- **The operator desk** — a dark, fast console: live session state, agent
  table with equity/buying-power/day-trades, tape of the biggest movers, the
  full activity stream, the news wire, per-agent drill-downs (orders, fills,
  positions, equity curve) and candlestick charts per symbol.
- **MCP adapter** — one stdio process per account; the API key lives only in
  the adapter env, never in tool output.

## Quickstart

```bash
npm ci
npx prisma generate
npm run db:push              # creates prime.db (absolute-URL safe)
npm run build
npm start                    # standalone server on :3000
```

Open `http://localhost:3000` → sign in with the operator passcode
(`MERIDIAN_OPERATOR_PASSCODE`, default `meridian-desk-2026` — change it before
exposing the desk anywhere).

### Route an AI agent in

From the console: **+ New agent account** → name, starting cash, account
type → the `mrp_live_…` API key is shown once. Then:

**REST**

```bash
curl -H "Authorization: Bearer mrp_live_..." http://localhost:3000/api/v1/account
curl -H "Authorization: Bearer mrp_live_..." -X POST http://localhost:3000/api/v1/orders \
  -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","side":"buy","orderType":"limit","qty":10,"limitPrice":249.50,"tif":"day"}'
```

**MCP** (Claude Desktop / Claude Code / Cursor)

```json
{
  "mcpServers": {
    "meridian-prime": {
      "command": "node",
      "args": ["/path/to/meridian-prime/src/mcp/server.mjs"],
      "env": {
        "MERIDIAN_API_KEY": "mrp_live_...",
        "MERIDIAN_BASE_URL": "http://localhost:3000/api/v1"
      }
    }
  }
}
```

**CLI**

```bash
node scripts/create-agent.mjs --name "Vega-1" --cash 1000000 --kind margin
```

### Live streaming (optional)

```bash
cd mini-services/relay && npm ci && npx tsx index.ts   # ws://localhost:3003
```

Set `MERIDIAN_RELAY_URL=http://localhost:3003` on the desk and
`NEXT_PUBLIC_RELAY_URL` for the browser.

## API surface

Machine-readable docs live at `GET /api/v1/docs`. Highlights:

| area | endpoints |
|------|-----------|
| account | `GET /account`, `/account/portfolio`, `/account/portfolio/history`, `/account/activities` |
| orders | `GET/POST /orders`, `GET/DELETE /orders/{id}` |
| positions | `GET /positions`, `GET /positions/{symbol}` |
| market | `GET /market/status`, `/market/calendar`, `/market/quote`, `/market/stocks`, `/market/stocks/{symbol}`, `/market/candles`, `/market/news` |

Rate limit: 120 req/min per key. Errors are structured:
`{"error":{"code":"insufficient_buying_power","message":"…"}}`.

## Configuration

| variable | default | purpose |
|----------|---------|---------|
| `DATABASE_URL` | `file:./prime.db` | SQLite file (absolute paths recommended in production) |
| `MERIDIAN_OPERATOR_PASSCODE` | `meridian-desk-2026` | console sign-in |
| `MERIDIAN_DATA_PROVIDER` | `yahoo` | `yahoo` (live) or `fixture` (recorded payloads, offline/CI) |
| `MERIDIAN_POLL_INTERVAL_MS` | `5000` | quote poll cadence |
| `MERIDIAN_MINUTE_REFRESH` | `8` | symbols whose 1-minute series refreshes per cycle |
| `MERIDIAN_CLOCK` | — | freeze the platform clock (ISO timestamp) for rehearsals |
| `MERIDIAN_RELAY_URL` / `MERIDIAN_RELAY_TOKEN` | — / `prime-relay` | push events to the relay |
| `NEXT_PUBLIC_RELAY_URL` | `http://localhost:3003` | browser-side relay endpoint |
| `MERIDIAN_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

## Data sources & network policy

**Zero accounts, zero API keys, zero credit cards.** Every piece of market
data — quotes, candles, dividend events, news headlines — is fetched from
Yahoo Finance's public endpoints with **no authentication of any kind**: no
API key, no OAuth, no cookie/crumb handshake. The outbound requests carry
only a browser `User-Agent` (rate-limit etiquette) and an `accept` header.

| outbound host | used for | auth |
|---------------|----------|------|
| `query1.finance.yahoo.com` | batched quotes (v7 spark), candles & dividend events (v8 chart) | none — public JSON |
| `feeds.finance.yahoo.com` | per-symbol news RSS | none — public feed |
| `localhost` / `127.0.0.1` | the desk's own API, MCP adapter and optional relay | the platform's *own* locally-issued credentials |

Nothing else is contacted: no telemetry, no third-party fonts or CDNs at
runtime, and the `fixture` data provider (`MERIDIAN_DATA_PROVIDER=fixture`,
used by CI) is fully offline against recorded payloads. The only secrets in
the system are issued by the platform itself — agent API keys (`mrp_live_…`),
the operator passcode and the optional relay token — and they never leave the
operator's machine.

This policy is enforced by `tests/unit/data-source-policy.test.ts`, which
fails the build on any new outbound host, any credential header in the data
plane, any keyed-provider SDK in `package.json`, or any hard-coded secret.

## Development

```bash
npm run typecheck          # strict tsc over src + tests
npm run lint               # eslint
npm run test:unit:coverage # vitest with the coverage gate
npm run test:e2e           # smoke · api-matrix · MCP · relay (needs a running server)
```

The unit suite (14 files, 120 tests) covers the calendar (DST, holidays,
early closes), fee schedule rounding, book synthesis, the fill/impact model,
accounting (PDT, settlement, margin), provider parsing against recorded real
payloads, the live fetch path (batching, per-symbol encoding, retries),
route handlers driven directly, the news wire, rate limiting — and a stealth
gate that scans every agent-facing surface (REST payloads, error strings,
MCP tool descriptions) to keep the API's language strictly that of a live
brokerage.

CI runs typecheck/lint/build, the unit suite at the coverage gate, and all
four e2e suites against a real standalone server on deterministic recorded
data. `release.yml` re-runs the whole matrix on a `v*` tag, then publishes a
prebuilt standalone zip + SHA256SUMS to GitHub Releases.

## Notes & limits

- Market data comes from a public provider endpoint without an API key;
  quotes are syntheses of the real tape (top-of-book around the last print)
  — real prices, modeled book.
- Splits are not processed (history is provider-adjusted; open positions
  through a split would need a manual correction).
- Cash-settled only in USD; no options/futures; no short locates — Reg-T
  shorting is assumed locate-eligible.
- The SQLite file is the system of record; take filesystem backups of it.

## License

MIT — see [LICENSE](./LICENSE).
