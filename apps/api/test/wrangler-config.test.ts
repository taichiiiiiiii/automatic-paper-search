// Parses the three wrangler configs this changeset (p5-plan.md §2 A6)
// touches and pins the plan's invariants structurally, rather than
// trusting hand-copied values. In particular the production KV id is
// compared against the root wrangler.jsonc's own id at test time, not
// against a literal in this file — the plan's own A6 text ships a
// possibly-truncated copy of that id (30 hex chars instead of 32), so
// this test is the thing that would have caught that had the production
// config been hand-typed from the plan instead of copied from the root
// file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "./helpers/jsonc.js";

const here = fileURLToPath(new URL(".", import.meta.url));

function readJsonc(relativePath: string): Record<string, unknown> {
  const text = readFileSync(new URL(relativePath, `file://${here}`), "utf8");
  return parseJsonc(text) as Record<string, unknown>;
}

const root = readJsonc("../../../wrangler.jsonc");
const production = readJsonc("../wrangler.jsonc");
const preview = readJsonc("../wrangler.preview.jsonc");

function kvId(config: Record<string, unknown>, binding: string): string | undefined {
  const list = config.kv_namespaces as Array<{ binding: string; id: string }> | undefined;
  return list?.find((entry) => entry.binding === binding)?.id;
}

describe("root wrangler.jsonc (sanity on the fixture this test depends on)", () => {
  it("has a 32-hex-character RATE_LIMIT_KV id", () => {
    const id = kvId(root, "RATE_LIMIT_KV");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
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

  it("matches the root config's GH_OWNER/GH_REPO/GH_WORKFLOW_FILE vars", () => {
    const vars = production.vars as Record<string, string>;
    const rootVars = root.vars as Record<string, string>;
    expect(vars.GH_OWNER).toBe(rootVars.GH_OWNER);
    expect(vars.GH_REPO).toBe(rootVars.GH_REPO);
    expect(vars.GH_WORKFLOW_FILE).toBe(rootVars.GH_WORKFLOW_FILE);
  });

  it("binds CONFIG_KV to the exact id the root config's RATE_LIMIT_KV uses", () => {
    // §6.1: binding names are per-Worker, so CONFIG_KV -> the same
    // namespace id RATE_LIMIT_KV already binds is intentional, not a typo.
    expect(kvId(production, "CONFIG_KV")).toBe(kvId(root, "RATE_LIMIT_KV"));
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
    expect(id).not.toBe(kvId(root, "RATE_LIMIT_KV"));
  });

  it("still has no D1 binding", () => {
    expect(preview.d1_databases).toBeUndefined();
  });
});
