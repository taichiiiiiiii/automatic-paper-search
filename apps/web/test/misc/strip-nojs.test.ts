import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNoJsRoute, stripScripts } from "../../scripts/strip-nojs";

/** Every built no-JS route dir (relative to out/): page 1 plus numbered pages. */
function builtNoJsDirs(out: string): string[] {
  const dirs: string[] = [];
  for (const conf of readdirSync(out)) {
    const rel = join(conf, "paper-links");
    if (!existsSync(join(out, rel, "index.html"))) continue;
    dirs.push(rel);
    for (const entry of readdirSync(join(out, rel))) {
      if (/^[1-9][0-9]*$/.test(entry)) dirs.push(join(rel, entry));
    }
  }
  return dirs;
}

const OUT = join(__dirname, "..", "..", "out");

describe("strip-nojs", () => {
  it("only targets per-conference paper-links routes", () => {
    expect(isNoJsRoute("cvpr-2026/paper-links")).toBe(true);
    expect(isNoJsRoute("cvpr-2026")).toBe(false);
    expect(isNoJsRoute("themes")).toBe(false);
    expect(isNoJsRoute("a/b/paper-links")).toBe(false);
    // R3-2: numbered pages 2..n of the split list are no-JS routes too.
    expect(isNoJsRoute("icml-2026/paper-links/2")).toBe(true);
    expect(isNoJsRoute("icml-2026/paper-links/0")).toBe(false);
    expect(isNoJsRoute("icml-2026/paper-links/x")).toBe(false);
    expect(isNoJsRoute("icml-2026/paper-links/2/3")).toBe(false);
  });

  it("removes inline, external and preloaded scripts but keeps content", () => {
    const html =
      '<head><link rel="preload" as="script" href="/a.js"/><link rel="stylesheet" href="/s.css"/></head>' +
      '<body><main><a href="https://arxiv.org/abs/1">x</a></main>' +
      '<script src="/b.js" async=""></script><script>self.__next_f.push([1,"big"])</script></body>';
    const out = stripScripts(html);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/as="script"/);
    expect(out).toContain('rel="stylesheet"');
    expect(out).toContain('<a href="https://arxiv.org/abs/1">x</a>');
  });

  it("built paper-links pages ship no script and stay within the 3MB budget (CAT-18)", () => {
    if (!existsSync(OUT)) return;
    const dirs = builtNoJsDirs(OUT);
    expect(dirs.length).toBeGreaterThan(0);
    for (const conf of dirs) {
      const html = readFileSync(join(OUT, conf, "index.html"), "utf8");
      expect(html, conf).not.toMatch(/<script/i);
      expect(Buffer.byteLength(html), conf).toBeLessThan(3 * 1024 * 1024);
    }
  });

  // LOW finding: Next's static export also writes a plain-text copy of
  // the RSC payload (index.txt) next to index.html, used for
  // client-side navigation prefetch. Stripping <script> tags does
  // nothing to that separate file -- it shipped a ~2.2MB duplicate of
  // the page's content on every no-JS paper-links route (observed on
  // cvpr-2026: 1.7MB index.html + 2.24MB index.txt) until this was
  // deleted outright.
  it("deletes index.txt (the RSC payload) alongside every no-JS paper-links route", () => {
    if (!existsSync(OUT)) return;
    const dirs = builtNoJsDirs(OUT);
    expect(dirs.length).toBeGreaterThan(0);
    for (const conf of dirs) {
      expect(existsSync(join(OUT, conf, "index.txt")), conf).toBe(false);
    }
  });
});
