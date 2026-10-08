import { describe, expect, it } from "vitest";
import {
  API_BASE,
  BASE_PATH,
  buildCspContent,
  buildNonScriptCspDirectives,
  canonicalUrl,
  LEGACY_GITHUB_PAGES_BASE_PATH,
  legacyGithubPagesUrl,
  PAGES_PRODUCTION_BRANCH,
  PAGES_PROJECT_NAME,
  PUBLIC_ORIGIN,
} from "../../src/site/config.js";

describe("PAGES_PROJECT_NAME", () => {
  it("is a non-empty string the staged workflows can reference as CF_PAGES_PROJECT (p5-plan.md §2 A5)", () => {
    expect(typeof PAGES_PROJECT_NAME).toBe("string");
    expect(PAGES_PROJECT_NAME.length).toBeGreaterThan(0);
  });
});

describe("PAGES_PRODUCTION_BRANCH", () => {
  it("is a non-empty string the staged workflows can reference as CF_PAGES_PRODUCTION_BRANCH (p5-plan.md §2 A5)", () => {
    expect(typeof PAGES_PRODUCTION_BRANCH).toBe("string");
    expect(PAGES_PRODUCTION_BRANCH.length).toBeGreaterThan(0);
  });
});

describe("BASE_PATH", () => {
  it("is empty: Cloudflare Pages serves from the domain root (design doc §4.1-4.2)", () => {
    expect(BASE_PATH).toBe("");
  });
});

describe("LEGACY_GITHUB_PAGES_BASE_PATH", () => {
  it("still carries the old GitHub Pages repo-name prefix", () => {
    expect(LEGACY_GITHUB_PAGES_BASE_PATH).toBe("/automatic-paper-search");
  });
});

describe("canonicalUrl", () => {
  it("joins PUBLIC_ORIGIN + BASE_PATH + path", () => {
    expect(canonicalUrl("/cvpr-2026/")).toBe(`${PUBLIC_ORIGIN}/cvpr-2026/`);
  });

  it('builds the site root URL for "/"', () => {
    expect(canonicalUrl("/")).toBe(`${PUBLIC_ORIGIN}/`);
  });

  it("never carries the legacy GitHub Pages prefix", () => {
    expect(canonicalUrl("/themes/")).not.toContain(LEGACY_GITHUB_PAGES_BASE_PATH);
  });

  it('throws if path does not start with "/"', () => {
    expect(() => canonicalUrl("cvpr-2026/")).toThrow(/must start with/);
  });
});

describe("legacyGithubPagesUrl", () => {
  it("builds the old github.io URL, including the repo-name prefix", () => {
    expect(legacyGithubPagesUrl("/cvpr-2026/")).toBe(
      "https://taichiiiiiiii.github.io/automatic-paper-search/cvpr-2026/",
    );
  });

  it('throws if path does not start with "/"', () => {
    expect(() => legacyGithubPagesUrl("cvpr-2026/")).toThrow(/must start with/);
  });
});

describe("buildNonScriptCspDirectives", () => {
  const directives = buildNonScriptCspDirectives();

  it("starts with default-src 'self'", () => {
    expect(directives[0]).toBe("default-src 'self'");
  });

  it("includes connect-src 'self' plus the API host", () => {
    expect(directives).toContain(`connect-src 'self' ${API_BASE}`);
  });

  it("locks down style-src, font-src, img-src, base-uri, form-action, object-src", () => {
    expect(directives).toContain("style-src 'self'");
    expect(directives).toContain("font-src 'self'");
    expect(directives).toContain("img-src 'self' data:");
    expect(directives).toContain("base-uri 'self'");
    expect(directives).toContain("form-action 'self'");
    expect(directives).toContain("object-src 'none'");
  });

  it("never includes a script-src directive (that is the one per-page exception)", () => {
    expect(directives.some((d) => d.startsWith("script-src"))).toBe(false);
  });

  it("never uses 'unsafe-inline'", () => {
    expect(directives.join(" ")).not.toContain("unsafe-inline");
  });

  it("returns a fresh array each call (no shared mutable state)", () => {
    const a = buildNonScriptCspDirectives();
    const b = buildNonScriptCspDirectives();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("buildCspContent", () => {
  it("places default-src first, the given script-src second, then the rest", () => {
    const content = buildCspContent("script-src 'self' 'sha256-abc123'");
    const directives = content.split("; ");
    expect(directives[0]).toBe("default-src 'self'");
    expect(directives[1]).toBe("script-src 'self' 'sha256-abc123'");
    expect(directives.slice(2)).toEqual(buildNonScriptCspDirectives().slice(1));
  });

  it("is byte-identical across calls for the same script-src (stable builds)", () => {
    const scriptSrc = "script-src 'self' 'sha256-xyz'";
    expect(buildCspContent(scriptSrc)).toBe(buildCspContent(scriptSrc));
  });

  it("carries the API host in connect-src", () => {
    expect(buildCspContent("script-src 'self'")).toContain(API_BASE);
  });
});
