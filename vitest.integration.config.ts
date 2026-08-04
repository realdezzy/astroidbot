import { defineConfig } from "vitest/config";

/**
 * Integration suites: live chains, real endpoints, sometimes a funded wallet.
 *
 * Separate from the default run because they are not deterministic and not
 * free. Cases needing credentials skip *visibly* (`it.skipIf`) rather than
 * returning early, so a run reports "3 passed, 2 skipped" instead of five
 * greens for two tests' worth of work.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    // Live endpoints are slower than mocks and occasionally slow *and* fine.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // One chain's endpoint being down must not be reported as another's.
    fileParallelism: false,
  },
});
