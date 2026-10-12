import { defineConfig } from "vitest/config";

/**
 * System tests (`pnpm test:system`): each file builds a throw-away repo copy
 * (`test/system/support/sandbox.ts`) and runs the REAL pipeline CLIs in it
 * with the recorded-fixture HTTP layer (`test/system/support/fixtureFetch.ts`).
 * Files run one at a time: every CLI is its own Node process already.
 */
export default defineConfig({
  test: {
    include: ["test/system/**/*.system.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
