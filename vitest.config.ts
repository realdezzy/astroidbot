import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Integration suites talk to live chains and, for some cases, need a
    // funded wallet. They are excluded from `npm test` and run by
    // `npm run test:integration`.
    //
    // They used to be in the default run, where every case that lacked its
    // credentials `return`ed early — so they reported as passing while
    // asserting nothing. A suite that cannot run should say so, not add to the
    // green count.
    exclude: ["node_modules/**", "dist/**", "tests/integration/**"],
  },
});
