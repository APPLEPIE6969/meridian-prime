#!/usr/bin/env node
// Provision an agent account from the command line.
//
//   node scripts/create-agent.mjs --name "Vega-1" [--cash 1000000] [--kind margin|cash]
//
// Prints the API key exactly once.

import path from 'node:path'
import fs from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

function projectRoot() {
  let dir = process.cwd()
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'prisma', 'schema.prisma'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function arg(flag, fallback) {
  const idx = process.argv.indexOf(flag)
  return idx >= 0 ? process.argv[idx + 1] : fallback
}

const name = arg('--name', '')
const cash = Number(arg('--cash', '1000000'))
const kind = arg('--kind', 'margin') === 'cash' ? 'cash' : 'margin'

if (!name) {
  console.error('usage: node scripts/create-agent.mjs --name "Vega-1" [--cash 1000000] [--kind margin]')
  process.exit(1)
}
if (!Number.isFinite(cash) || cash <= 0) {
  console.error('--cash must be a positive number')
  process.exit(1)
}

// Resolve the database URL the same way the runtime does.
let dbUrl = process.env.DATABASE_URL || 'file:./prime.db'
const root = projectRoot()
if (dbUrl.startsWith('file:') && !path.isAbsolute(dbUrl.slice(5))) {
  dbUrl = `file:${path.join(root, dbUrl.slice(5))}`
}
process.env.DATABASE_URL = dbUrl

const prisma = new PrismaClient()
const apiKey = `mrp_live_${randomBytes(24).toString('hex')}`

try {
  const account = await prisma.account.create({
    data: {
      name,
      keyHash: createHash('sha256').update(apiKey).digest('hex'),
      keyPreview: `mrp_live_…${apiKey.slice(-4)}`,
      kind,
      startingCash: cash,
    },
  })
  await prisma.cashLedger.create({
    data: { accountId: account.id, kind: 'deposit', amount: cash, settled: true },
  })
  await prisma.activity.create({
    data: { accountId: account.id, kind: 'account_opened', message: `Account opened with $${cash.toLocaleString('en-US')}` },
  })
  console.log(`account ${account.id} (${kind}) opened for "${name}" with $${cash.toLocaleString('en-US')}`)
  console.log(`API key (shown once): ${apiKey}`)
} catch (err) {
  if (String(err).includes('Unique constraint')) {
    console.error(`an agent named "${name}" already exists`)
  } else {
    console.error(err instanceof Error ? err.message : String(err))
  }
  process.exit(1)
} finally {
  await prisma.$disconnect()
}
