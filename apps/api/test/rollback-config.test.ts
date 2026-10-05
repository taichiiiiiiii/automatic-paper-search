// Parses wrangler.legacy-rollback.jsonc (repo root, new per p5-plan.md
// §2 A6) and checks worker/rollback-entry.ts's source for the two things
// the plan requires of it: re-exporting worker/index.ts's default and
// adding a stub QuotaCounter. worker/ is not part of any workspace
// package (no package.json, not in pnpm-workspace.yaml, excluded from
// biome.json's includes — same as worker/index.ts today), so there is no
// tsconfig/vitest project that can import or typecheck
// worker/rollback-entry.ts; this test reads its source text instead of
// executing it, which is enough to pin the two required exports and the
// 503 status without inventing a new run target for a single file that
// no deploy path reads yet (Tier A: inert).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "./helpers/jsonc.js";

const here = fileURLToPath(new URL(".", import.meta.url));

function readText(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${here}`), "utf8");
}

function readJsonc(relativePath: string): Record<string, unknown> {
  return parseJsonc(readText(relativePath)) as Record<string, unknown>;
}

function kvId(config: Record<string, unknown>, binding: string): string | undefined {
  const list = config.kv_namespaces as Array<{ binding: string; id: string }> | undefined;
  return list?.find((entry) => entry.binding === binding)?.id;
}

const root = readJsonc("../../../wrangler.jsonc");
const rollback = readJsonc("../../../wrangler.legacy-rollback.jsonc");

describe("wrangler.legacy-rollback.jsonc", () => {
  it("deploys onto the same Worker name as the current production config", () => {
    // Same name => `wrangler deploy -c wrangler.legacy-rollback.jsonc`
    // redeploys the existing Worker rather than creating a new one.
    expect(rollback.name).toBe(root.name);
    expect(rollback.name).toBe("paperpilot-themes");
  });

  it("points main at worker/rollback-entry.ts, not worker/index.ts", () => {
    expect(rollback.main).toBe("worker/rollback-entry.ts");
  });

  it("matches the root config's vars exactly", () => {
    expect(rollback.vars).toEqual(root.vars);
  });

  it("binds RATE_LIMIT_KV to the same id as the root config", () => {
    expect(kvId(rollback, "RATE_LIMIT_KV")).toBe(kvId(root, "RATE_LIMIT_KV"));
  });

  it("adds the QUOTA binding with the same v1 new_sqlite_classes migration apps/api uses", () => {
    const bindings = (rollback.durable_objects as { bindings: Array<Record<string, string>> })
      .bindings;
    expect(bindings).toEqual([{ name: "QUOTA", class_name: "QuotaCounter" }]);
    expect(rollback.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["QuotaCounter"] }]);
  });

  it("has no D1 binding", () => {
    expect(rollback.d1_databases).toBeUndefined();
  });
});

describe("worker/rollback-entry.ts", () => {
  const source = readText("../../../worker/rollback-entry.ts");

  it("re-exports worker/index.ts's default handler", () => {
    expect(source).toMatch(/export\s*\{\s*default\s*\}\s*from\s*["']\.\/index\.js["']/);
  });

  it("exports a stub QuotaCounter class", () => {
    expect(source).toMatch(/export\s+class\s+QuotaCounter/);
  });

  it("the stub answers 503 to every request", () => {
    expect(source).toMatch(/status:\s*503/);
  });
});
