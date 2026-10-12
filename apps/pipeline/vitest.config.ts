import { configDefaults, defineConfig } from "vitest/config";

/**
 * Unit/integration suite (`pnpm test`). The end-to-end system tests under
 * `test/system/` spawn the real CLIs in a temp repo copy and run as their
 * own CI job (`pnpm test:system`, `vitest.system.config.ts`).
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/system/**"],
  },
});
