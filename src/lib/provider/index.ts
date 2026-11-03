import { cfg } from '../config'
import { chainedProvider } from './chain'
import { fixtureProvider } from './fixture'
import { yahooProvider } from './yahoo'
import type { MarketDataProvider } from './types'

// Static imports keep the registry bundle-safe (no dynamic require), while
// the provider choice itself stays a lazy per-call decision so tests can
// flip MERIDIAN_DATA_PROVIDER at runtime. Live mode always means the real
// tape: the chained provider fails over across independent keyless sources
// and never degrades to recorded fixtures.

export function activeProvider(): MarketDataProvider {
  return cfg().dataProvider === 'fixture' ? fixtureProvider : chainedProvider
}

export type { MarketDataProvider, Quote, Candle, DividendEvent, NewsHeadline } from './types'
export { yahooProvider, fixtureProvider, chainedProvider }
export { dataHealth, resetChainHealth, type SourceHealth } from './chain'
