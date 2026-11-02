#!/usr/bin/env node
// db push wrapper: resolves DATABASE_URL to an absolute path (the Prisma CLI
// resolves relative file: URLs against the schema directory, the runtime
// against the process cwd — pinning the absolute form keeps them identical).

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

function projectRoot() {
  let dir = process.cwd()
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

const root = projectRoot()
let url = process.env.DATABASE_URL || 'file:./prime.db'
if (url.startsWith('file:') && !path.isAbsolute(url.slice(5))) {
  url = `file:${path.join(root, url.slice(5))}`
}

const result = spawnSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, DATABASE_URL: url },
})
process.exit(result.status ?? 1)
