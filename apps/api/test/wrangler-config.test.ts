// Parses apps/api's two wrangler configs (p5-plan.md §2 A6) and pins the
// plan's invariants structurally. The production KV id and GH_* vars used
// to be compared against the root wrangler.jsonc of the old worker/; that
// file was deleted in Tier C (p5-plan.md §6.3), so its last values are
// pinned below as literals instead (the §6.1 production namespace id).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "./helpers/jsonc.js";

const here = fileURLToPath(new URL(".", import.meta.url));

function readJsonc(relativePath: string): Record<string, unknown> {
  const text = readFileSync(new URL(relativePath, `file://${here}`), "utf8");
  return parseJsonc(text) as Record<string, unknown>;
}

const production = readJsonc("../wrangler.jsonc");
const preview = readJsonc("../wrangler.preview.jsonc");

function kvId(config: Record<string, unknown>, binding: string): string | undefined {
  const list = config.kv_namespaces as Array<{ binding: string; id: string }> | undefined;
  return list?.find((entry) => entry.binding === binding)?.id;
}

// Last values of the deleted root wrangler.jsonc (legacy worker/), which
// the production Worker took over unchanged.
const PRODUCTION_KV_ID = "3e11d3e73dae42a8b94f06a9fa9de19f";
const LEGACY_VARS = {
  GH_OWNER: "taichiiiiiiii",
  GH_REPO: "automatic-paper-search",
  GH_WORKFLOW_FILE: "theme-on-demand.yml",
} as const;

describe("pinned legacy values (sanity on the literals this test depends on)", () => {
  it("is a 32-hex-character KV id", () => {
    expect(PRODUCTION_KV_ID).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("apps/api/wrangler.jsonc (production, p5-plan.md §2 A6)", () => {
  it("is named paperpilot-themes with the Hono entry point", () => {
    expect(production.name).toBe("paperpilot-themes");
    expect(production.main).toBe("src/index.ts");
  });

  it("sets DISPATCH_MODE=live and GH_REF=develop", () => {
    const vars = production.vars as Record<string, string>;
    expect(vars.DISPATCH_MODE).toBe("live");
    expect(vars.GH_REF).toBe("develop");
  });

  it("keeps the legacy Worker's GH_OWNER/GH_REPO/GH_WORKFLOW_FILE vars", () => {
    const vars = production.vars as Record<string, string>;
    expect(vars.GH_OWNER).toBe(LEGACY_VARS.GH_OWNER);
    expect(vars.GH_REPO).toBe(LEGACY_VARS.GH_REPO);
    expect(vars.GH_WORKFLOW_FILE).toBe(LEGACY_VARS.GH_WORKFLOW_FILE);
  });

  it("binds CONFIG_KV to the exact id the legacy RATE_LIMIT_KV used", () => {
    // §6.1: binding names are per-Worker, so CONFIG_KV -> the same
    // namespace id RATE_LIMIT_KV already binds is intentional, not a typo.
    expect(kvId(production, "CONFIG_KV")).toBe(PRODUCTION_KV_ID);
  });

  it("has the QUOTA Durable Object binding with the v1 new_sqlite_classes migration", () => {
    const bindings = (production.durable_objects as { bindings: Array<Record<string, string>> })
      .bindings;
    expect(bindings).toEqual([{ name: "QUOTA", class_name: "QuotaCounter" }]);
    expect(production.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["QuotaCounter"] }]);
  });

  it("has no D1 binding", () => {
    expect(production.d1_databases).toBeUndefined();
  });
});

describe("apps/api/wrangler.preview.jsonc (unchanged preview config, now its own file)", () => {
  it("keeps a different name and dry-run mode", () => {
    expect(preview.name).not.toBe("paperpilot-themes");
    const vars = preview.vars as Record<string, string>;
    expect(vars.DISPATCH_MODE).toBe("dry-run");
  });

  it("does not use the production KV id", () => {
    const id = kvId(preview, "CONFIG_KV");
    expect(id).not.toBe(kvId(production, "CONFIG_KV"));
    expect(id).not.toBe(PRODUCTION_KV_ID);
  });

  it("still has no D1 binding", () => {
    expect(preview.d1_databases).toBeUndefined();
  });
});
