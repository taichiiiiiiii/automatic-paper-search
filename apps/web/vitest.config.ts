import { defineConfig } from "vitest/config";

/**
 * Minimal Vitest config, added for the P2 review's M4/M5 component
 * tests (test/themes/theme-request-form.test.tsx), which render real
 * JSX via @testing-library/react under `// @vitest-environment jsdom`.
 *
 * Without this file, Vite/Vitest's standalone esbuild transform for
 * .tsx defaults to the CLASSIC JSX runtime (`React.createElement(...)`
 * calls with no import), while this tsconfig's `"jsx": "preserve"` is
 * meant for Next's own SWC build step and isn't read by esbuild here --
 * every component in apps/web (correctly, for the automatic runtime
 * Next/SWC actually uses) omits the `import React from "react"` a
 * classic transform would need, so rendering any of them under plain
 * `vitest run` throws `ReferenceError: React is not defined`. Setting
 * the automatic runtime here matches what the real Next build does,
 * with no new dependency and no change to any component file.
 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
});
