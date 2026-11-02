// The tradable universe: 48 real US listings — 42 operating companies and
// 6 sector SPDR ETFs across 9 GICS sectors. Symbols are live instruments on
// NYSE/Nasdaq; quotes, candles, dividends and headlines all come straight
// from the market data provider.

export type InstrumentKind = 'stock' | 'etf'

export interface Instrument {
  symbol: string
  name: string
  sector: string
  kind: InstrumentKind
  exchange: 'NASDAQ' | 'NYSE' | 'NYSEArca'
}

export const SECTORS = [
  'Technology',
  'Communication Services',
  'Consumer Discretionary',
  'Consumer Staples',
  'Financials',
  'Health Care',
  'Industrials',
  'Energy',
  'Utilities',
] as const

export const UNIVERSE: Instrument[] = [
  // ── Technology (6) ────────────────────────────────────────────────────────
  { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'MSFT', name: 'Microsoft Corporation', sector: 'Technology', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', sector: 'Technology', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'AVGO', name: 'Broadcom Inc.', sector: 'Technology', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'ORCL', name: 'Oracle Corporation', sector: 'Technology', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'ADBE', name: 'Adobe Inc.', sector: 'Technology', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'XLK', name: 'Technology Select Sector SPDR Fund', sector: 'Technology', kind: 'etf', exchange: 'NYSEArca' },

  // ── Communication Services (5) ───────────────────────────────────────────
  { symbol: 'GOOGL', name: 'Alphabet Inc.', sector: 'Communication Services', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'META', name: 'Meta Platforms, Inc.', sector: 'Communication Services', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'NFLX', name: 'Netflix, Inc.', sector: 'Communication Services', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'DIS', name: 'The Walt Disney Company', sector: 'Communication Services', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'TMUS', name: 'T-Mobile US, Inc.', sector: 'Communication Services', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'XLC', name: 'Communication Services Select Sector SPDR Fund', sector: 'Communication Services', kind: 'etf', exchange: 'NYSEArca' },

  // ── Consumer Discretionary (5) ───────────────────────────────────────────
  { symbol: 'AMZN', name: 'Amazon.com, Inc.', sector: 'Consumer Discretionary', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'TSLA', name: 'Tesla, Inc.', sector: 'Consumer Discretionary', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'HD', name: 'The Home Depot, Inc.', sector: 'Consumer Discretionary', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'MCD', name: "McDonald's Corporation", sector: 'Consumer Discretionary', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'NKE', name: 'NIKE, Inc.', sector: 'Consumer Discretionary', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'XLY', name: 'Consumer Discretionary Select Sector SPDR Fund', sector: 'Consumer Discretionary', kind: 'etf', exchange: 'NYSEArca' },

  // ── Consumer Staples (5) ─────────────────────────────────────────────────
  { symbol: 'PG', name: 'The Procter & Gamble Company', sector: 'Consumer Staples', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'KO', name: 'The Coca-Cola Company', sector: 'Consumer Staples', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'PEP', name: 'PepsiCo, Inc.', sector: 'Consumer Staples', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'COST', name: 'Costco Wholesale Corporation', sector: 'Consumer Staples', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'WMT', name: 'Walmart Inc.', sector: 'Consumer Staples', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'XLP', name: 'Consumer Staples Select Sector SPDR Fund', sector: 'Consumer Staples', kind: 'etf', exchange: 'NYSEArca' },

  // ── Financials (5) ───────────────────────────────────────────────────────
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.', sector: 'Financials', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'BAC', name: 'Bank of America Corporation', sector: 'Financials', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'WFC', name: 'Wells Fargo & Company', sector: 'Financials', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'GS', name: 'The Goldman Sachs Group, Inc.', sector: 'Financials', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'V', name: 'Visa Inc.', sector: 'Financials', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'XLF', name: 'Financial Select Sector SPDR Fund', sector: 'Financials', kind: 'etf', exchange: 'NYSEArca' },

  // ── Health Care (5) ──────────────────────────────────────────────────────
  { symbol: 'UNH', name: 'UnitedHealth Group Incorporated', sector: 'Health Care', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'LLY', name: 'Eli Lilly and Company', sector: 'Health Care', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Health Care', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'ABBV', name: 'AbbVie Inc.', sector: 'Health Care', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'PFE', name: 'Pfizer Inc.', sector: 'Health Care', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'XLV', name: 'Health Care Select Sector SPDR Fund', sector: 'Health Care', kind: 'etf', exchange: 'NYSEArca' },

  // ── Industrials (4) ──────────────────────────────────────────────────────
  { symbol: 'CAT', name: 'Caterpillar Inc.', sector: 'Industrials', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'BA', name: 'The Boeing Company', sector: 'Industrials', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'HON', name: 'Honeywell International Inc.', sector: 'Industrials', kind: 'stock', exchange: 'NASDAQ' },
  { symbol: 'UNP', name: 'Union Pacific Corporation', sector: 'Industrials', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'XLI', name: 'Industrial Select Sector SPDR Fund', sector: 'Industrials', kind: 'etf', exchange: 'NYSEArca' },

  // ── Energy (4) ───────────────────────────────────────────────────────────
  { symbol: 'XOM', name: 'Exxon Mobil Corporation', sector: 'Energy', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'CVX', name: 'Chevron Corporation', sector: 'Energy', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'COP', name: 'ConocoPhillips', sector: 'Energy', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'SLB', name: 'Schlumberger Limited (SLB)', sector: 'Energy', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'XLE', name: 'Energy Select Sector SPDR Fund', sector: 'Energy', kind: 'etf', exchange: 'NYSEArca' },

  // ── Utilities (3) ────────────────────────────────────────────────────────
  { symbol: 'NEE', name: 'NextEra Energy, Inc.', sector: 'Utilities', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'DUK', name: 'Duke Energy Corporation', sector: 'Utilities', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'SO', name: 'The Southern Company', sector: 'Utilities', kind: 'stock', exchange: 'NYSE' },
  { symbol: 'XLU', name: 'Utilities Select Sector SPDR Fund', sector: 'Utilities', kind: 'etf', exchange: 'NYSEArca' },
]

export const SYMBOLS: string[] = UNIVERSE.map((i) => i.symbol)

const bySymbol = new Map(UNIVERSE.map((i) => [i.symbol, i]))

export function getInstrument(symbol: string): Instrument | undefined {
  return bySymbol.get(symbol.toUpperCase())
}

export function isListed(symbol: string): boolean {
  return bySymbol.has(symbol.toUpperCase())
}

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}
