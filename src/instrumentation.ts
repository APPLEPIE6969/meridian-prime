// Runtime bootstrap. Next.js calls register() once per server process before
// routes serve traffic: normalize the database path, then start the market
// feed, trading engine loops and the news wire.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const g = globalThis as unknown as { __meridianBooted?: boolean }
  if (g.__meridianBooted) return
  g.__meridianBooted = true

  const { resolveDatabaseUrl } = await import('./lib/db')
  resolveDatabaseUrl()

  const { tradingEngine } = await import('./lib/engine/engine')
  const { cfg } = await import('./lib/config')
  const { log } = await import('./lib/log')

  tradingEngine().startLoops()
  log('info', 'runtime up', { provider: cfg().dataProvider })
}
