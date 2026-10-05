/**
 * M2 of the P4 review, package-wide inventory check: every `*Cli.ts` /
 * `cli.ts` file must guard its entry block with the shared
 * `isMain(import.meta.url)` helper — not the naive
 * `import.meta.url === \`file://${process.argv[1]}\`` string comparison
 * (breaks on a symlinked/space-containing/non-ASCII invocation path) or
 * any other hand-rolled reimplementation. This greps source text rather
 * than importing every file: importing would pull each CLI's whole
 * dependency graph into one test file for no benefit (the guard is a
 * single textual pattern, not behaviour that needs exercising here —
 * `isMain.test.ts` covers the helper's behaviour, `isMainEntry.spawn.test.ts`
 * covers it end-to-end through a real symlink/space path).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../../../src", import.meta.url));

function findCliFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      out.push(...findCliFiles(path));
    } else if (/(^cli\.ts$|Cli\.ts$)/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const NAIVE_GUARD_PATTERNS = [
  /import\.meta\.url\s*===\s*`file:\/\/\$\{(process\.)?argv\[1\]\}`/,
  /process\.argv\[1\]\?\.endsWith\(/,
];

describe("every *Cli.ts / cli.ts uses the shared isMain guard (M2 inventory)", () => {
  const files = findCliFiles(SRC_ROOT);

  it("found the expected set of CLI entry files (fails loudly if the inventory drifts)", () => {
    // Not a hardcoded count — just a sanity floor so a refactor that
    // silently stops matching files (e.g. a rename away from *Cli.ts)
    // is caught here instead of this whole test suite going quiet.
    expect(files.length).toBeGreaterThanOrEqual(18);
  });

  for (const file of files) {
    const rel = file.slice(SRC_ROOT.length + 1);
    const source = readFileSync(file, "utf-8");

    it(`${rel}: does not use a naive file://\${argv[1]} / endsWith guard`, () => {
      for (const pattern of NAIVE_GUARD_PATTERNS) {
        expect(source).not.toMatch(pattern);
      }
    });

    it(`${rel}: guards its entry block with isMain(import.meta.url)`, () => {
      expect(source).toMatch(/isMain\(import\.meta\.url\)/);
      expect(source).toMatch(
        /import\s*\{[^}]*\bisMain\b[^}]*\}\s*from\s*"[^"]*shared\/cli\/isMain\.js"/,
      );
    });
  }
});
