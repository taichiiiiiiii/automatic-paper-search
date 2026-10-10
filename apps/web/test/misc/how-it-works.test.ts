import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = join(TEST_DIR, "..", "..", "app", "how-it-works");
const PAGE_SOURCE = join(PAGE_DIR, "page.tsx");
const STYLES_SOURCE = join(PAGE_DIR, "how-it-works.module.css");
/**
 * The page this port has to reproduce. A frozen byte-identical copy of
 * `docs/how-it-works/index.html` (docs/migration/p5-plan.md §2 A1): the
 * test must not read the real `docs/` tree at test time (it moves/goes
 * away under P5 §5.1, and would otherwise pass/fail on whatever the
 * pipeline last wrote there instead of a fixed contract). See
 * apps/web/test/fixtures/legacy/README.md for how it was captured.
 */
const LEGACY_PAGE = join(TEST_DIR, "..", "fixtures", "legacy", "how-it-works", "index.html");
const BUILT_PAGE = join(TEST_DIR, "..", "..", "out", "how-it-works", "index.html");

/** Regions whose rendered copy must survive the port, by CSS class in the
 * current page (each is a single-class attribute in docs/how-it-works). */
const COPY_REGIONS = [
  "hero__breadcrumb",
  "hero__lede",
  "section-head__note",
  "rel-row__ja",
  "rel-row__key",
  "rel-row__meaning",
  "rel-row__eg",
  "how__steps",
  "how__body",
  // seealso__note / seealso__links diverge on purpose since the cutover: the
  // legacy page linked to design docs 01-38 and docs/research, which were
  // removed (b7d1be4). The built page links to design doc 39 and
  // docs/migration instead; see the dedicated test below.
  "guide-cta",
] as const;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const SCRIPT_BLOCK_RE = /<script\b[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_RE = /<style\b[\s\S]*?<\/style>/gi;
const TAG_RE = /<[^>]*>/g;
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const CSS_URL_RE = /url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g;

/** A stylesheet with its comments and url() payloads removed, so only real
 * selectors and declarations are left to inspect. */
function cssCode(css: string): string {
  return css.replace(CSS_COMMENT_RE, "").replace(CSS_URL_RE, "");
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Text with element markup, comments and all whitespace removed, so a port
 * can be compared on its copy alone (JSX folds a source line break into one
 * space exactly like HTML does, so both sides collapse the same way). */
function plainText(html: string): string {
  return (
    html
      .replace(SCRIPT_BLOCK_RE, "")
      .replace(STYLE_BLOCK_RE, "")
      .replace(HTML_COMMENT_RE, "")
      .replace(TAG_RE, "")
      // Entities: the source page writes `&nbsp;` where React emits U+00A0;
      // decode before collapsing whitespace so both sides compare on text.
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, "")
  );
}

function headings(html: string): string[] {
  const cleaned = html.replace(SCRIPT_BLOCK_RE, "").replace(HTML_COMMENT_RE, "");
  const found: string[] = [];
  for (const match of cleaned.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    found.push(plainText(match[2] ?? ""));
  }
  return found;
}

/** Squashed text of every element carrying `className` (single-class form). */
function regionTexts(html: string, className: string): string[] {
  const pattern = new RegExp(
    `<([a-z0-9]+)\\b[^>]*class="${className}"[^>]*>([\\s\\S]*?)</\\1>`,
    "gi",
  );
  const cleaned = html.replace(HTML_COMMENT_RE, "");
  return [...cleaned.matchAll(pattern)].map((match) => plainText(match[2] ?? ""));
}

describe("how-it-works page source", () => {
  const pageSource = read(PAGE_SOURCE);
  const stylesheet = read(STYLES_SOURCE);

  it("only uses CSS-module classes that the module defines", () => {
    const defined = new Set(
      [...cssCode(stylesheet).matchAll(/\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1] ?? ""),
    );
    const referenced = new Set(
      [...pageSource.matchAll(/\bstyles\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1] ?? ""),
    );
    // A missing class would silently render the literal "undefined" into the
    // markup, so both directions are pinned.
    for (const name of referenced) {
      expect(defined.has(name), `.${name} is used but not defined`).toBe(true);
    }
    for (const name of defined) {
      expect(referenced.has(name), `.${name} is defined but unused`).toBe(true);
    }
  });

  it("keeps the CSS module free of raw color literals", () => {
    const body = cssCode(stylesheet);
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toContain("rgb(");
    // Tokens only, except the one alpha-composited hero gradient the current
    // sheet already writes out (oklch is the token format itself).
    expect(body.match(/oklch\(/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("stays CSP-safe: no inline style, no innerHTML, no inline <style>", () => {
    expect(pageSource).not.toMatch(/\bstyle=/);
    expect(pageSource).not.toContain("dangerouslySetInnerHTML");
    expect(pageSource).not.toContain("<style");
    expect(stylesheet).not.toContain("@import");
  });

  it('follows the layout contract: one <main id="main-content"> root', () => {
    expect(pageSource).toContain('<main id="main-content"');
    expect(pageSource.match(/<main\b/g)?.length).toBe(1);
    expect(pageSource).not.toContain("<SiteHeader");
    expect(pageSource).not.toContain("<SiteFooter");
  });

  it("takes its URL from the site config, not a hard-coded origin", () => {
    expect(pageSource).not.toContain("taichiiiiiiii.github.io");
    expect(pageSource).toContain('path: "/how-it-works/"');
  });
});

describe("built /how-it-works/ page parity with docs/how-it-works/index.html", () => {
  const legacy = read(LEGACY_PAGE);

  it.skipIf(!existsSync(BUILT_PAGE))("renders the same headings in the same order", () => {
    expect(headings(read(BUILT_PAGE))).toEqual(headings(legacy));
  });

  it.skipIf(!existsSync(BUILT_PAGE))("renders every copy region of the current page", () => {
    const built = plainText(read(BUILT_PAGE));
    const labels: string[] = [];
    for (const region of COPY_REGIONS) {
      const texts = regionTexts(legacy, region);
      expect(texts.length, `no .${region} found in the current page`).toBeGreaterThan(0);
      for (const text of texts) {
        expect(built, `.${region} copy is missing from the built page`).toContain(text);
      }
      if (region === "rel-row__ja") {
        labels.push(...texts);
      }
    }
    expect(labels).toHaveLength(6);
  });

  it.skipIf(!existsSync(BUILT_PAGE))(
    "keeps the six relations in the current order (置換 … 対立)",
    () => {
      const built = plainText(read(BUILT_PAGE));
      const order = regionTexts(legacy, "rel-row__ja");
      let previous = -1;
      for (const label of order) {
        const at = built.indexOf(label);
        expect(at, `${label} missing`).toBeGreaterThan(-1);
        expect(at, `${label} out of order`).toBeGreaterThan(previous);
        previous = at;
      }
    },
  );

  it.skipIf(!existsSync(BUILT_PAGE))("links only to design docs that still exist", () => {
    const built = readFileSync(BUILT_PAGE, "utf8");
    expect(built).toContain("docs/design/39-typescript-cloudflare-migration.md");
    expect(built).toContain("tree/develop/docs/migration");
    expect(built).not.toMatch(/docs\/design\/(0[1-9]|[12][0-9]|3[0-8])-|docs\/research/);
  });

  it.skipIf(!existsSync(BUILT_PAGE))(
    "explains the publication tiers (design doc 41 D1: audited / unaudited)",
    () => {
      const built = plainText(read(BUILT_PAGE));
      expect(built).toContain("「監査済み」");
      expect(built).toContain("「未監査（自動生成）」");
      expect(built).toContain("自動検査（形式・識別子・関係の根拠）に合格した系譜");
    },
  );

  it.skipIf(!existsSync(BUILT_PAGE))("emits no inline style for the CSP contract", () => {
    const built = read(BUILT_PAGE);
    expect(built).not.toMatch(/<[a-z][^>]*\sstyle\s*=\s*"/i);
    expect(built.includes("<style")).toBe(false);
  });

  it("has a heading list to compare at all (h1 + three h2)", () => {
    expect(headings(legacy)).toHaveLength(4);
  });
});
