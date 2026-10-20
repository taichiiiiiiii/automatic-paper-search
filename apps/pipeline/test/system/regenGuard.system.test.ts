/**
 * System test (R2-37): the 2026-10-12 incident, end to end through the REAL
 * theme CLI with recorded APIs.
 *
 * regen-themes.yml rebuilt a published, unaudited theme at plain depth 1;
 * the complete, evidence-classified rebuild had too few lineage relations,
 * so the quality table would have blocked it, and the release replaced a
 * visible theme with a hidden one. Here a published flash-attention theme
 * plays that role and a stricter `theme_min_lineage_edges` makes the
 * recorded depth-1 rebuild fall short of it while the published file still
 * passes. The guard must keep the published files byte-identical and exit 6.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grown, type Lineage, serialize } from "../lineage/theme/publishGuardFixtures.js";
import { describeRun, runCli } from "./support/runCli.js";
import { createSandbox, type Sandbox } from "./support/sandbox.js";
import { THEME_ARGS, THEME_DIR } from "./support/scenarios.js";

const FIXTURES = ["theme-s2-counts", "theme-http"];
const POLICY = "data/config/lineage-quality-policy-v1.json";
const AUDITS = "data/config/lineage-audit-fixtures-v1.json";
const LINEAGE_RELATIONS = new Set(["extends", "successor", "supersedes", "contrasts", "ablation"]);
/** THEME_ARGS without the reaudit override: the plain incident invocation. */
const REGEN_ARGS = THEME_ARGS.filter((a) => a !== "--allow-reaudit");

function snapshot(sb: Sandbox, rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string): void => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
    else
      out[p.slice(sb.root.length + 1)] = createHash("sha1").update(readFileSync(p)).digest("hex");
  };
  walk(sb.path(rel));
  return out;
}

function lineageRelations(path: string): number {
  const lin = JSON.parse(readFileSync(path, "utf8")) as { edges: { relation: string }[] };
  return lin.edges.filter((e) => LINEAGE_RELATIONS.has(e.relation)).length;
}

let sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes) s.cleanup();
  sandboxes = [];
});

const realPolicy = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../../${POLICY}`, import.meta.url), "utf8"));

/**
 * A sandbox with the published flash-attention theme. `audited: false`
 * empties the audit fixtures (the theme is then unaudited, like the LoRA
 * theme of the incident); `publish` rewrites the published lineage before
 * the sandbox's base commit.
 */
function sandbox(options: {
  audited: boolean;
  policyPatch?: Record<string, unknown>;
  publish?: (published: Lineage) => Lineage;
}): Sandbox {
  const files: Record<string, unknown> = { [POLICY]: { ...realPolicy(), ...options.policyPatch } };
  if (!options.audited) {
    files[AUDITS] = { schema_version: "lineage-audit-fixtures-v1", collections: [] };
  }
  const sb = createSandbox({ copyData: [THEME_DIR], files });
  sandboxes.push(sb);
  if (options.publish) {
    const path = sb.path(THEME_DIR, "lineage.json");
    writeFileSync(path, serialize(options.publish(JSON.parse(readFileSync(path, "utf8")))));
    sb.git("commit", "-qam", "test: synthetic published theme");
  }
  return sb;
}

/** Two more evidence-quoted lineage relations than the recorded rebuild has. */
function richerLineage(l: Lineage): Lineage {
  let k = 0;
  return {
    ...l,
    edges: l.edges.map((e) =>
      e.relation === "baseline_only" && k++ < 2 ? { ...e, relation: "extends", rel: "extends" } : e,
    ),
  };
}

describe("R2-37 publish guard: a regen whose build would be blocked keeps the published theme", () => {
  it("the incident: plain depth-1 regen of an unaudited theme, rebuild short of lineage relations -> exit 6, files byte-identical", async () => {
    // Published: >= 5 lineage relations. Recorded depth-1 rebuild: 4. Policy: 5.
    const sb = sandbox({
      audited: false,
      policyPatch: { theme_min_lineage_edges: 5 },
      publish: richerLineage,
    });
    const pub = JSON.parse(readFileSync(sb.path(THEME_DIR, "lineage.json"), "utf8")) as Lineage;
    const pubShape = `${pub.nodes.length} nodes / ${pub.edges.length} edges`;
    expect(lineageRelations(sb.path(THEME_DIR, "lineage.json"))).toBeGreaterThanOrEqual(5);
    const before = snapshot(sb, "data/published");
    const result = sb.path("..", "result.json");
    const run = await runCli(sb, "lineage/theme/cli.ts", [...REGEN_ARGS, "--result-json", result], {
      fixtures: FIXTURES,
    });
    expect(run.code, describeRun(run)).toBe(6);
    expect(run.requests.filter((r) => r.outcome === "miss")).toEqual([]);
    expect(run.stderr).toContain(
      `publish guard: published flash-attention is unaudited (${pubShape}`,
    );
    expect(run.stdout).toContain(
      `::error::theme "Flash Attention": refusing to replace the published unaudited theme (${pubShape}) ` +
        "with a build the publication gate would block (14 nodes / 36 edges; " +
        // R2-40: 3 (the recorded rebuild's weak-cue “We follow the FlashAttention
        // algorithms” extends is usage now; was 4).
        "failed: lineage_relation_count failed (observed 3, expected 5))",
    );
    expect(run.stderr).not.toMatch(/^wrote /m);
    expect(snapshot(sb, "data/published")).toEqual(before);
    expect(sb.git("status", "--porcelain", "--", "data/published")).toBe("");
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({
      status: "regression_refused",
      exit_code: 6,
    });
  });

  it("--match-published retries the refused depth-1 rebuild expanded; when that cannot complete, the files still stay byte-identical", async () => {
    const sb = sandbox({
      audited: false,
      policyPatch: { theme_min_lineage_edges: 5 },
      publish: richerLineage,
    });
    const before = snapshot(sb, "data/published");
    const run = await runCli(sb, "lineage/theme/cli.ts", [...REGEN_ARGS, "--match-published"], {
      fixtures: FIXTURES,
    });
    expect(run.stderr).toMatch(
      /auto-expand: first pass refused by the publish guard .*; retrying with --depth 2 --seeds 10 --width 12/,
    );
    // The expanded pass asks for URLs the depth-1 recording does not have
    // (a dead network to it): it must fail closed, not publish.
    expect(run.code, describeRun(run)).not.toBe(0);
    expect(snapshot(sb, "data/published")).toEqual(before);
  });

  it("refuses a rebuild with under half the published nodes unless --allow-shrink", async () => {
    const sb = sandbox({ audited: false, publish: (l) => grown(20, l) }); // 34 nodes
    const before = snapshot(sb, "data/published");
    const refused = await runCli(sb, "lineage/theme/cli.ts", REGEN_ARGS, { fixtures: FIXTURES });
    expect(refused.code, describeRun(refused)).toBe(6);
    expect(refused.stdout).toMatch(
      /build of 14 nodes \/ 36 edges \(< 50% of the published nodes\)/,
    );
    expect(snapshot(sb, "data/published")).toEqual(before);

    const forced = await runCli(sb, "lineage/theme/cli.ts", [...REGEN_ARGS, "--allow-shrink"], {
      fixtures: FIXTURES,
    });
    expect(forced.code, describeRun(forced)).toBe(0);
    const lin = JSON.parse(readFileSync(sb.path(THEME_DIR, "lineage.json"), "utf8")) as Lineage;
    expect(lin.nodes).toHaveLength(14);
  });

  it("an audited theme is not hidden by a rebuild that invalidates its audit unless --allow-reaudit", async () => {
    const sb = sandbox({ audited: true });
    const before = snapshot(sb, "data/published");
    const refused = await runCli(sb, "lineage/theme/cli.ts", REGEN_ARGS, { fixtures: FIXTURES });
    expect(refused.code, describeRun(refused)).toBe(6);
    expect(refused.stdout).toMatch(/published audited theme .*re-audited.*--allow-reaudit/);
    expect(snapshot(sb, "data/published")).toEqual(before);

    const accepted = await runCli(sb, "lineage/theme/cli.ts", THEME_ARGS, { fixtures: FIXTURES });
    expect(THEME_ARGS).toContain("--allow-reaudit");
    expect(accepted.code, describeRun(accepted)).toBe(0);
    expect(snapshot(sb, "data/published")).not.toEqual(before);
  });
});
