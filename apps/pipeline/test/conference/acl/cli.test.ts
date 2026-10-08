/**
 * ACL CLI entry point (LOW of the P4 review: "ACL has no CLI entry
 * point"). This file used to pin a LOCAL `isMain()` this module exported
 * (its own `realpathSync`-based guard, predating the shared helper). M2
 * of the P4 review promoted that exact logic to the package-wide
 * `shared/cli/isMain.ts` (covered by `test/shared/cli/isMain.test.ts`,
 * including the symlink case) and this file now calls that shared
 * helper instead of defining its own — it no longer exports an `isMain`
 * of its own to test in isolation. What's worth pinning here is that the
 * entry guard actually fires for THIS file specifically, end-to-end,
 * which `isMainEntry.test.ts`'s spawn-based tests cover across every
 * CLI including this one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../../src/conference/acl/cli.ts", import.meta.url)),
  "utf-8",
);

describe("ACL CLI entry point uses the shared isMain guard", () => {
  it("imports isMain from the package-wide shared/cli/isMain module", () => {
    expect(SOURCE).toMatch(
      /import\s*\{\s*isMain\s*\}\s*from\s*"\.\.\/\.\.\/shared\/cli\/isMain\.js"/,
    );
  });

  it("guards main() with isMain(import.meta.url), not a local reimplementation", () => {
    expect(SOURCE).toMatch(/if\s*\(\s*isMain\(import\.meta\.url\)\s*\)\s*\{\s*main\(\);/);
  });

  it("no longer defines a local isMain() of its own", () => {
    expect(SOURCE).not.toMatch(/export function isMain\(/);
    expect(SOURCE).not.toMatch(/import\s*\{\s*realpathSync\s*\}/);
  });

  it("no longer uses the naive file://(argv[1]) string-comparison guard", () => {
    expect(SOURCE).not.toMatch(/file:\/\/\$\{process\.argv\[1\]\}/);
  });
});
