import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The credit ledger tests deliberately race concurrent transactions against
    // one MySQL instance. Running files in parallel would let unrelated
    // suites truncate the tables mid-race, so they run one at a time.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globals: false,
    reporters: ['default'],
  },
});
