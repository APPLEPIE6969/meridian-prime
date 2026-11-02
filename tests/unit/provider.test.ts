import { describe, expect, it } from 'vitest'
import { candlesFromChart, dividendsFromChart, parseChartEnvelope, parseRss, parseSparkEnvelope, quoteFromSparkItem } from '@/lib/provider/yahoo'
import { repoPath } from '@/lib/paths'
import fs from 'node:fs'

const spark = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'spark-1.json'), 'utf8'))
const aaplIntraday = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-intraday.json'), 'utf8'))
const aaplDaily = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-daily.json'), 'utf8'))
const aaplDividends = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'chart-AAPL-dividends.json'), 'utf8'))
const rss = fs.readFileSync(repoPath('tests', 'fixtures', 'news-AAPL.xml'), 'utf8')

describe('spark (batch quotes) parsing', () => {
  it('parses every symbol in the recorded batch', () => {
    const items = parseSparkEnvelope(spark)
    expect(items.length).toBe(16)
    const first = quoteFromSparkItem(items[0])
    expect(first).not.toBeNull()
    expect(first!.symbol).toBe(items[0].symbol)
    expect(first!.last).toBeGreaterThan(0)
    expect(first!.bid).toBeLessThan(first!.ask)
    expect(first!.prevClose).toBeGreaterThan(0)
    expect(first!.dayVolume).toBeGreaterThan(0)
  })

  it('carries real market fields from the payload', () => {
    const items = parseSparkEnvelope(spark)
    const aapl = items.find((i) => i.symbol === 'AAPL')
    expect(aapl).toBeDefined()
    const q = quoteFromSparkItem(aapl!)
    expect(q!.prevClose).toBe(348.91) // recorded real prior close
    expect(q!.dayHigh).toBeGreaterThanOrEqual(q!.dayLow)
  })

  it('returns an empty list for malformed payloads', () => {
    expect(parseSparkEnvelope({})).toEqual([])
    expect(parseSparkEnvelope({ spark: { result: [{}] } }).length).toBe(1)
    expect(quoteFromSparkItem({ symbol: 'X', response: [] })).toBeNull()
    expect(quoteFromSparkItem({ symbol: 'X', response: [{ meta: {} }] })).toBeNull()
  })
})

describe('chart (candles) parsing', () => {
  it('extracts minute bars from the intraday envelope', () => {
    const result = parseChartEnvelope(aaplIntraday)
    expect(result).not.toBeNull()
    const bars = candlesFromChart(result!)
    expect(bars.length).toBeGreaterThan(100)
    const bar = bars[0]
    expect(bar.o).toBeGreaterThan(0)
    expect(bar.h).toBeGreaterThanOrEqual(bar.l)
    expect(bar.c).toBeGreaterThan(0)
    expect(bar.t).toBeGreaterThan(1_600_000_000_000)
  })

  it('extracts daily history (years of bars)', () => {
    const result = parseChartEnvelope(aaplDaily)
    const bars = candlesFromChart(result!)
    expect(bars.length).toBeGreaterThan(1000)
    expect(bars[0].t).toBeLessThan(bars[bars.length - 1].t)
  })

  it('extracts dividend events', () => {
    const result = parseChartEnvelope(aaplDividends)
    const divs = dividendsFromChart(result!)
    expect(divs.length).toBeGreaterThan(0)
    for (const div of divs) {
      expect(div.amount).toBeGreaterThan(0)
      expect(div.exDate).toBeGreaterThan(1_700_000_000_000)
    }
  })

  it('skips bars with null closes', () => {
    const synthetic = {
      chart: {
        result: [
          {
            meta: {},
            timestamp: [1, 2, 3],
            indicators: { quote: [{ open: [1, null, 3], high: [1, null, 3], low: [1, null, 3], close: [1, null, 3], volume: [10, null, 30] }] },
          },
        ],
      },
    }
    const bars = candlesFromChart(parseChartEnvelope(synthetic)!)
    expect(bars.length).toBe(2)
  })

  it('returns null for error envelopes', () => {
    expect(parseChartEnvelope({ chart: { error: { code: 'Bad Request' } } })).toBeNull()
    expect(parseChartEnvelope({})).toBeNull()
  })
})

describe('RSS (news wire) parsing', () => {
  it('parses recorded real headlines', () => {
    const items = parseRss(rss, 'AAPL')
    expect(items.length).toBeGreaterThan(3)
    for (const item of items) {
      expect(item.headline.length).toBeGreaterThan(10)
      expect(item.url).toMatch(/^https:\/\//)
      expect(item.providerId.length).toBeGreaterThan(0)
      expect(item.publishedAt.getTime()).toBeGreaterThan(0)
    }
  })

  it('decodes HTML entities in titles', () => {
    const sample = '<item><title>Apple &amp; partners &lt;launch&gt; &quot;product&quot;</title><link>https://example.com/a</link><guid>g1</guid><pubDate>Mon, 02 Nov 2026 10:00:00 +0000</pubDate></item>'
    const items = parseRss(sample, 'AAPL')
    expect(items[0].headline).toBe('Apple & partners <launch> "product"')
  })

  it('drops items without a title or link', () => {
    const sample = '<item><guid>g2</guid></item><item><title>T</title><link>https://example.com/b</link><guid>g3</guid></item>'
    expect(parseRss(sample, 'AAPL').length).toBe(1)
  })
})
