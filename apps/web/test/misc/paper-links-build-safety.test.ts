import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Review finding M1 (continued): `readPapers` in
 * app/[conf]/paper-links/page.tsx used to call `notFound()` on a
 * missing papers.json, which a static export renders as a real,
 * 200-status page -- the build stayed green while silently shipping a
 * 404 look-alike at a real URL. The fix replaced that call with a
 * thrown Error (see paper-links-build-guard.test.ts for the
 * generateStaticParams-level guard that should make this unreachable in
 * practice; this file pins the fallback itself and, once a real build
 * exists, that no built page is a disguised not-found page).
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(TEST_DIR, "..", "..");
const PAGE_SOURCE = join(WEB_ROOT, "app", "[conf]", "paper-links", "page.tsx");
const OUT_DIR = join(WEB_ROOT, "out");

describe("paper-links page.tsx readPapers", () => {
  it("fails the build with a thrown Error instead of next/navigation's notFound()", () => {
    const source = readFileSync(PAGE_SOURCE, "utf8");
    expect(source).not.toContain("notFound()");
    expect(source).not.toMatch(/from\s+"next\/navigation"/);
    expect(source).toMatch(/throw new Error/);
  });
});

describe("paper-links head metadata", () => {
  it.skipIf(!existsSync(OUT_DIR))(
    "built /<conf>/paper-links/ pages are noindex and carry no self-canonical link",
    () => {
      const confs = readdirSync(OUT_DIR).filter((d) =>
        existsSync(join(OUT_DIR, d, "paper-links", "index.html")),
      );
      expect(confs.length).toBeGreaterThan(0);
      for (const conf of confs) {
        const html = readFileSync(join(OUT_DIR, conf, "paper-links", "index.html"), "utf8");
        expect(html, conf).toMatch(/<meta name="robots" content="noindex, follow"\s*\/?>/);
        // The original docs/<conf>/paper-links.html never carried a
        // self-canonical tag; a canonical pointing at a noindex page is
        // a contradictory signal to crawlers.
        expect(html, conf).not.toMatch(/<link rel="canonical"/);
      }
    },
  );
});

describe("built paper-links pages are never a disguised not-found page", () => {
  it.skipIf(!existsSync(OUT_DIR))(
    "every built /<conf>/paper-links/ page renders real rows, not the not-found fallback",
    () => {
      const confs = readdirSync(OUT_DIR).filter((d) =>
        existsSync(join(OUT_DIR, d, "paper-links", "index.html")),
      );
      expect(confs.length).toBeGreaterThan(0);
      for (const conf of confs) {
        const html = readFileSync(join(OUT_DIR, conf, "paper-links", "index.html"), "utf8");
        expect(html, conf).not.toMatch(/This page could not be found/i);
        // Either real rows, or the page's own (not Next's) empty-state copy.
        expect(
          html.includes("data-paper-id=") || html.includes("掲載できる論文はありません"),
          conf,
        ).toBe(true);
      }
    },
  );
});
