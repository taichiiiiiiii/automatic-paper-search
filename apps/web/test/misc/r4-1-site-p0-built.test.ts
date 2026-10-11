/**
 * Built-output checks for design doc 48 P0 (R4-1). Each test reads the
 * static export and skips when `apps/web/out` is missing (same pattern as
 * how-it-works.test.ts); CI builds before testing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(TEST_DIR, "..", "..", "out");
const INDEX = join(OUT, "index.html");
const HOW = join(OUT, "how-it-works", "index.html");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** First catalog page `out/<conf>/index.html` (any conference). */
function firstCatalogPage(): string | null {
  if (!existsSync(OUT)) return null;
  for (const name of readdirSync(OUT).sort()) {
    if (!/^[a-z]+-\d{4}$/.test(name)) continue;
    const p = join(OUT, name, "index.html");
    if (existsSync(p)) return p;
  }
  return null;
}

describe("built output: R4-1 site P0", () => {
  it.skipIf(!existsSync(INDEX))(
    "the static top page does not claim that no lineage is published (P0-4)",
    () => {
      const html = read(INDEX);
      expect(html).not.toContain("公開条件を満たす系譜は現在ありません");
      expect(html).not.toContain("公開できる系譜は準備中です");
      expect(html).not.toContain("系譜データは現在公開準備中です");
      expect(html).not.toContain("スライドの一般向け自動生成");
      expect(html).toContain("系譜一覧を読み込んでいます");
    },
  );

  it.skipIf(!existsSync(HOW))("the 仕組み page explains the main path and the error report", () => {
    const html = read(HOW);
    expect(html).toContain('id="main-path"');
    expect(html).toContain("本流（主経路）");
    expect(html).toContain("search path count");
    expect(html).toContain("誤りを報告");
  });

  const catalog = firstCatalogPage();
  it.skipIf(catalog === null)("catalog pages show the data date (R1-3)", () => {
    const html = read(catalog as string);
    expect(html).toContain("データの日付");
    expect(html).toMatch(/data-data-date="\d{4}-\d{2}-\d{2}"/);
  });
});
