// Market data contracts shared by every provider.

export interface Quote {
  symbol: string
  last: number
  bid: number
  ask: number
  bidSize: number
  askSize: number
  prevClose: number
  dayHigh: number
  dayLow: number
  dayVolume: number
  /** Provider print time (epoch ms). */
  ts: number
}

export interface Candle {
  /** Bar open time (epoch ms). */
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface DividendEvent {
  /** Ex-dividend date (epoch ms at market open). */
  exDate: number
  amount: number
}

export interface NewsHeadline {
  providerId: string
  headline: string
  source: string
  url: string
  symbols: string[]
  summary: string
  publishedAt: Date
}

export interface MarketDataProvider {
  name: string
  getQuote(symbol: string): Promise<Quote | null>
  getQuotes(symbols: string[]): Promise<Quote[]>
  /** Today's 1-minute bars (empty when unavailable). */
  getMinuteBars(symbol: string): Promise<Candle[]>
  getDailyHistory(symbol: string, range?: string): Promise<Candle[]>
  getDividends(symbol: string, range?: string): Promise<DividendEvent[]>
  getNews(symbols: string[], limit?: number): Promise<NewsHeadline[]>
}
