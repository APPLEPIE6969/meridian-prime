import fs from 'node:fs'
import path from 'node:path'

let cachedRoot: string | null = null

/**
 * Locate the project root by walking up from the working directory until a
 * package.json is found. The standalone server chdir's into its own bundle
 * directory, and Prisma resolves relative SQLite URLs against the process
 * working directory — normalizing through this walker keeps the database and
 * fixture paths stable in every runtime (dev server, standalone build, tests).
 */
export function projectRoot(): string {
  if (cachedRoot) return cachedRoot
  let dir = process.cwd()
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      cachedRoot = dir
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  cachedRoot = process.cwd()
  return cachedRoot
}

export function repoPath(...segments: string[]): string {
  return path.join(projectRoot(), ...segments)
}

/** Test seam: forget the cached root so the next lookup re-walks. */
export function resetProjectRoot(): void {
  cachedRoot = null
}
