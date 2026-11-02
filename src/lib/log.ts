import { cfg } from './config'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const

export type LogLevel = keyof typeof LEVELS

/** Structured single-line JSON logging. No silent failures anywhere. */
export function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  const configured = LEVELS[cfg().logLevel as LogLevel] ?? LEVELS.info
  if (LEVELS[level] < configured) return
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(meta ?? {}) })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
