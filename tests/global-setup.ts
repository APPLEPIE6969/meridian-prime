import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Vitest global setup: give the suite a FRESH database at an absolute path
// (the standalone/CLI relative-URL mismatch is exactly what the runtime
// resolver normalizes, so tests pin the absolute form).

const root = path.resolve(import.meta.dirname, '..')
const dbPath = path.join(root, '.vitest.db')

export function setup(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`
    if (fs.existsSync(file)) fs.rmSync(file)
  }
  process.env.DATABASE_URL = `file:${dbPath}`
  process.env.MERIDIAN_DATA_PROVIDER = 'fixture'
  execSync('npx prisma db push --accept-data-loss --skip-generate', {
    cwd: root,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: 'pipe',
  })
}

export function teardown(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`
    if (fs.existsSync(file)) fs.rmSync(file)
  }
}
