import { cfg } from '../config'
import { fixtureProvider } from './fixture'
import { yahooProvider } from './yahoo'
import type { MarketDataProvider } from './types'

// Static imports keep the registry bundle-safe (no dynamic require), while
// the provider choice itself stays a lazy per-call decision so tests can
// flip MERIDIAN_DATA_PROVIDER at runtime.

export function activeProvider(): MarketDataProvider {
  return cfg().dataProvider === 'fixture' ? fixtureProvider : yahooProvider
}

export type { MarketDataProvider, Quote, Candle, DividendEvent, NewsHeadline } from './types'
export { yahooProvider, fixtureProvider }
