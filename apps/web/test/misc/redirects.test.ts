import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_RULE_LIMIT,
  dynamicRuleCount,
  isDynamicRule,
  LEGACY_HTML_RULES,
  renderRedirects,
  renderRule,
} from "../../scripts/redirects";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BUILT_REDIRECTS = join(TEST_DIR, "..", "..", "out", "_redirects");

/**
 * The `.html` URLs the current GitHub Pages site really answers, and the
 * directory URL Next's static export writes instead (design doc §4.2-3).
 * Pinned as a mapping, so adding or renaming a rule is a deliberate act.
 */
const EXPECTED_MAPPING: Readonly<Record<string, string>> = {
  "/:conf/lineage.html": "/:conf/lineage/",
  "/:conf/deep.html": "/:conf/deep/",
  "/:conf/paper-links.html": "/:conf/paper-links/",
  "/:conf/index.html": "/:conf/",
  "/index.html": "/",
};

describe("legacy .html redirect rules", () => {
  it("maps exactly the required .html paths, all 301", () => {
    const mapping: Record<string, string> = {};
    for (const rule of LEGACY_HTML_RULES) {
      expect(rule.status).toBe(301);
      mapping[rule.from] = rule.to;
    }
    expect(mapping).toEqual(EXPECTED_MAPPING);
  });

  it("uses no wildcard or splat, only :placeholders", () => {
    for (const rule of LEGACY_HTML_RULES) {
      expect(rule.from).not.toContain("*");
      expect(rule.to).not.toContain("*");
    }
  });

  it("keeps every target in the trailing-slash directory form", () => {
    for (const rule of LEGACY_HTML_RULES) {
      expect(rule.from.endsWith(".html"), rule.from).toBe(true);
      expect(rule.to.endsWith("/"), rule.to).toBe(true);
    }
  });

  it("only substitutes placeholders the rule itself captured", () => {
    for (const rule of LEGACY_HTML_RULES) {
      for (const placeholder of rule.to.match(/:[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
        expect(rule.from.includes(placeholder), `${rule.from} -> ${rule.to}`).toBe(true);
      }
    }
  });

  it("declares each source path once, scoped rules before the site-wide one", () => {
    const sources = LEGACY_HTML_RULES.map((rule) => rule.from);
    expect(new Set(sources).size).toBe(sources.length);
    expect(sources[sources.length - 1]).toBe("/index.html");
  });

  it("stays inside the Cloudflare Pages free-plan dynamic-rule budget", () => {
    expect(DYNAMIC_RULE_LIMIT).toBe(100);
    // 4 placeholder rules + 1 static rule, far below the 100 dynamic ceiling.
    expect(dynamicRuleCount(LEGACY_HTML_RULES)).toBe(4);
    expect(dynamicRuleCount(LEGACY_HTML_RULES)).toBeLessThan(DYNAMIC_RULE_LIMIT);
  });
});

describe("redirects rendering", () => {
  it("writes one `<from> <to> <status>` line per rule", () => {
    expect(renderRule({ from: "/a.html", to: "/a/", status: 301 })).toBe("/a.html /a/ 301");
  });

  it("reports the budget it is charged against in the header", () => {
    const rendered = renderRedirects();
    expect(rendered).toContain("# Rules: 1 static, 4 dynamic of 100 allowed.");
  });

  it("is a comment header plus exactly the rule lines, newline-terminated", () => {
    const lines = renderRedirects().split("\n");
    expect(lines.at(-1)).toBe(""); // file ends with a newline
    const body = lines.filter((line) => line !== "" && !line.startsWith("#"));
    expect(body).toEqual(LEGACY_HTML_RULES.map(renderRule));
    for (const line of lines) {
      if (line === "" || line.startsWith("#")) {
        continue;
      }
      expect(line.split(" ")).toHaveLength(3);
    }
  });

  it("classifies only placeholder rules as dynamic", () => {
    expect(isDynamicRule({ from: "/index.html", to: "/", status: 301 })).toBe(false);
    expect(isDynamicRule({ from: "/:conf/deep.html", to: "/:conf/deep/", status: 301 })).toBe(true);
  });
});

describe("built out/_redirects", () => {
  // Skipped until the parent wires scripts/redirects.ts into postbuild and a
  // `next build` has produced apps/web/out (same convention as test/csp.test.ts).
  it.skipIf(!existsSync(BUILT_REDIRECTS))(
    "matches what scripts/redirects.ts generates (no hand-edits survive)",
    () => {
      expect(readFileSync(BUILT_REDIRECTS, "utf8")).toBe(renderRedirects());
    },
  );
});
