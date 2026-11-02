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
      include: ['src/lib/**', 'src/app/api/**'],
      exclude: ['**/*.d.ts'],
      // Locked to the measured reality of the suite (minus a hair of slack
      // for environment variance). CI fails if coverage regresses below
      // these floors.
      thresholds: {
        statements: 84,
        branches: 71,
        functions: 87,
        lines: 84,
      },
    },
  },
})
