// NewsWire — the desk's headline service.
//
// Headlines come from the provider's per-symbol feeds and are persisted so
// the console and agents see the same wire. The upsert MERGES symbol tags on
// dedupe (a headline picked up by two different symbol feeds accumulates
// both tags instead of losing the first one).

import { db } from '../db'
import { log } from '../log'
import { activeProvider } from '../provider'
import { SYMBOLS } from '../universe'

const BATCH = 8
const REFRESH_MS = 120_000

export interface WireHeadline {
  id: string
  providerId: string
  headline: string
  source: string
  url: string
  symbols: string[]
  summary: string
  publishedAt: string
}

export class NewsWire {
  private timer: ReturnType<typeof setInterval> | null = null
  private cursor = 0
  private busy = false
  lastRefreshAt = 0
  lastError: string | null = null

  async refresh(symbols?: string[]): Promise<number> {
    if (this.busy) return 0
    this.busy = true
    try {
      const universe = symbols ?? this.nextBatch()
      const provider = activeProvider()
      const items = await provider.getNews(universe, 24)
      let stored = 0
      for (const item of items) {
        const existing = await db().newsItem.findUnique({ where: { providerId: item.providerId } })
        if (existing) {
          const merged = Array.from(new Set([...jsonSymbols(existing.symbols), ...item.symbols]))
          await db().newsItem.update({
            where: { providerId: item.providerId },
            data: { symbols: JSON.stringify(merged), headline: item.headline, summary: item.summary },
          })
        } else {
          await db().newsItem.create({
            data: {
              providerId: item.providerId,
              headline: item.headline,
              source: item.source,
              url: item.url,
              symbols: JSON.stringify(item.symbols),
              summary: item.summary,
              publishedAt: item.publishedAt,
            },
          })
          stored++
        }
      }
      this.lastRefreshAt = Date.now()
      this.lastError = null
      return stored
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      log('warn', 'news refresh failed', { error: this.lastError })
      return 0
    } finally {
      this.busy = false
    }
  }

  private nextBatch(): string[] {
    const batch: string[] = []
    for (let i = 0; i < BATCH; i++) {
      batch.push(SYMBOLS[this.cursor % SYMBOLS.length])
      this.cursor++
    }
    return batch
  }

  async latest(opts: { symbols?: string[]; limit?: number } = {}): Promise<WireHeadline[]> {
    const limit = Math.min(Math.max(1, opts.limit ?? 25), 100)
    const rows = await db().newsItem.findMany({
      orderBy: { publishedAt: 'desc' },
      take: 200,
    })
    const filtered = opts.symbols && opts.symbols.length > 0
      ? rows.filter((row) => {
          const tags = jsonSymbols(row.symbols)
          return opts.symbols!.some((s) => tags.includes(s.toUpperCase()))
        })
      : rows
    return filtered.slice(0, limit).map((row) => ({
      id: row.id,
      providerId: row.providerId,
      headline: row.headline,
      source: row.source,
      url: row.url,
      symbols: jsonSymbols(row.symbols),
      summary: row.summary ?? '',
      publishedAt: row.publishedAt.toISOString(),
    }))
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.refresh()
    }, REFRESH_MS)
    this.timer.unref?.()
    void this.refresh()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

function jsonSymbols(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

const g = globalThis as unknown as { __meridianNews?: NewsWire }

export function newsWire(): NewsWire {
  if (!g.__meridianNews) g.__meridianNews = new NewsWire()
  return g.__meridianNews
}

export function resetNewsWire(): void {
  g.__meridianNews?.stop()
  g.__meridianNews = undefined
}
