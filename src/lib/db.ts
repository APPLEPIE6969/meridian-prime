import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { projectRoot } from './paths'

const g = globalThis as unknown as {
  __meridianPrisma?: PrismaClient
}

/**
 * Normalize DATABASE_URL to an absolute file path rooted at the project
 * directory. Prisma resolves relative `file:` URLs against the process
 * working directory, and the standalone server chdir's into its bundle
 * directory before the client is constructed — without this normalization
 * the CLI and the runtime would open two different databases.
 */
export function resolveDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL ?? 'file:./prime.db'
  if (!raw.startsWith('file:')) return raw
  const filePath = raw.slice('file:'.length)
  if (path.isAbsolute(filePath)) return raw
  return `file:${path.join(projectRoot(), filePath)}`
}

export function db(): PrismaClient {
  if (!g.__meridianPrisma) {
    const url = resolveDatabaseUrl()
    if (url !== process.env.DATABASE_URL) process.env.DATABASE_URL = url
    g.__meridianPrisma = new PrismaClient({ log: [] })
  }
  return g.__meridianPrisma
}

/** Test seam: drop the process-wide client. */
export function setDb(client: PrismaClient): void {
  g.__meridianPrisma = client
}

export function resetDb(): void {
  g.__meridianPrisma = undefined
}
