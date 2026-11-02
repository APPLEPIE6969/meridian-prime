import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Vitest is the unit/integration gate for Meridian Prime.
//
// Everything is resolved against this file's own directory (import.meta
// works under the vitest transform; relative paths do not survive a nested
// checkout next to another project that also has a vitest.config.ts).

const root = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: [path.resolve(root, 'tests/setup.ts')],
    include: ['tests/unit/**/*.test.ts'],
    globalSetup: [path.resolve(root, 'tests/global-setup.ts')],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 120000,
    // The engine, quote feed and news wire are process-global singletons
    // over one SQLite database; one fork keeps state transitions realistic.
    isolate: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      // Full server-side surface: every trading, market-data and API module.
      // The console UI (src/app pages, src/components) is exercised end-to-end
      // by the e2e suites (smoke, api-matrix, mcp-protocol, ws-relay) against
      // a real built server instead of mocked component rendering, and the
      // MCP adapter (mcp/server.mjs) and the Socket.IO relay
      // (mini-services/relay) run as separate processes validated by the
      // stealth and relay e2e suites.
      include: ['src/lib/**', 'src/app/api/**'],
      // Pure type declarations — no runtime statements to cover.
      exclude: ['**/*.d.ts', 'src/lib/provider/types.ts'],
      // The suite holds the entire server surface at 100% across all four
      // metrics; CI fails if any line, branch or function drops out.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
