/**
 * R2-37: the theme CLI's publish guard and gate-aware auto-expand, driven
 * through `runThemeCli` with a fake build that honours `publishGuard` the
 * way `buildThemeLineage` does (check the exact bytes, throw before the
 * write).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BuildThemeLineageDeps,
  BuildThemeLineageOptions,
} from "../../../src/lineage/theme/build.js";
import { parseArgs, runThemeCli } from "../../../src/lineage/theme/cli.js";
import {
  EXIT_REGRESSION_REFUSED,
  RegressionRefusedError,
} from "../../../src/lineage/theme/publishGuard.js";
import {
  FA_THEME,
  faText,
  GUARD_AUDIT_FIXTURES,
  GUARD_POLICY,
  grown,
  serialize,
  withDepth,
  withoutLineageRelations,
} from "./publishGuardFixtures.js";

let dir: string;
let out: string;
let resultPath: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-guard-"));
  out = join(dir, "lineage.json");
  resultPath = join(dir, "result.json");
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    stdout += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
    stderr += String(c);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const deps = (): BuildThemeLineageDeps => ({
  fetchImpl: async () => ({ status: 500, json: async () => ({}) }),
  cacheDir: dir,
  sleep: async () => {},
  docsRoot: dir,
  identityAliasesPath: join(dir, "identity-aliases-v1.json"),
  githubCachePath: join(dir, "github_stars.json"),
  wallClockNow: () => new Date("2026-10-12T12:00:00Z"),
});

/** Fake build: pass i writes `passes[i]` unless the guard refuses it. */
function fakeBuild(passes: string[]) {
  const calls: { depth: number; seedsCount: number; width: number }[] = [];
  const buildFn = async (o: BuildThemeLineageOptions): Promise<string> => {
    calls.push({ depth: o.depth, seedsCount: o.seedsCount, width: o.width });
    const text = passes[Math.min(calls.length - 1, passes.length - 1)] as string;
    const refusal = o.publishGuard?.(text, out) ?? null;
    if (refusal !== null) throw new RegressionRefusedError(refusal);
    writeFileSync(out, text);
    return out;
  };
  return { calls, buildFn };
}

const REGEN = ["--depth", "1", "--seeds", "5", "--width", "8", "--since-year", "2018"];
const run = (
  flags: string[],
  buildFn: (o: BuildThemeLineageOptions) => Promise<string>,
  fixturesPath: string | null = null,
) =>
  runThemeCli(
    ["--theme", FA_THEME, ...REGEN, ...flags, "--output", out, "--result-json", resultPath],
    { deps: deps(), buildFn, policyPath: GUARD_POLICY, fixturesPath },
  );
const weak = (l = grown(3)) => serialize(withoutLineageRelations(l));
const result = () => JSON.parse(readFileSync(resultPath, "utf-8"));

describe("parseArgs (R2-37 flags)", () => {
  it("defaults the new flags off", () => {
    expect(parseArgs(["--theme", "X"])).toMatchObject({
      matchPublished: false,
      allowShrink: false,
      allowReaudit: false,
    });
    expect(
      parseArgs(["--theme", "X", "--match-published", "--allow-shrink", "--allow-reaudit"]),
    ).toMatchObject({ matchPublished: true, allowShrink: true, allowReaudit: true });
  });
});

describe("publish guard: the 2026-10-12 incident (regen without expansion)", () => {
  it("refuses a blocked rebuild of a published theme: exit 6, file byte-identical, ::error::", async () => {
    writeFileSync(out, faText());
    const { calls, buildFn } = fakeBuild([weak(withDepth(1))]);
    const rc = await run([], buildFn);
    expect(rc).toBe(EXIT_REGRESSION_REFUSED);
    expect(calls).toHaveLength(1);
    expect(readFileSync(out, "utf-8")).toBe(faText());
    expect(stdout).toMatch(
      /::error::theme "Flash Attention": refusing to replace the published unaudited theme \(14 nodes \/ 46 edges\)/,
    );
    expect(stdout).toMatch(/lineage_relation_count failed/);
    expect(result()).toMatchObject({ status: "regression_refused", exit_code: 6 });
  });

  it("a brand-new theme has nothing to protect: a blocked build is still written (the quality table hides it)", async () => {
    const { buildFn } = fakeBuild([weak()]);
    expect(await run([], buildFn)).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it(`refuses a publishable build under half the published nodes unless --allow-shrink`, async () => {
    const big = serialize(grown(20)); // 34 nodes
    writeFileSync(out, big);
    const { buildFn } = fakeBuild([faText()]); // 14 nodes
    expect(await run([], buildFn)).toBe(EXIT_REGRESSION_REFUSED);
    expect(readFileSync(out, "utf-8")).toBe(big);
    expect(stdout).toMatch(/< 50% of the published nodes/);
    expect(await run(["--allow-shrink"], fakeBuild([faText()]).buildFn)).toBe(0);
    expect(readFileSync(out, "utf-8")).toBe(faText());
  });

  it("an audited theme is not silently hidden by a rebuild (stale audit) unless --allow-reaudit", async () => {
    writeFileSync(out, faText()); // audited: GUARD_AUDIT_FIXTURES is bound to these bytes
    const rebuilt = serialize(grown(3));
    expect(await run([], fakeBuild([rebuilt]).buildFn, GUARD_AUDIT_FIXTURES)).toBe(
      EXIT_REGRESSION_REFUSED,
    );
    expect(readFileSync(out, "utf-8")).toBe(faText());
    expect(stdout).toMatch(/published audited theme.*re-audited.*--allow-reaudit/);
    expect(await run(["--allow-reaudit"], fakeBuild([rebuilt]).buildFn, GUARD_AUDIT_FIXTURES)).toBe(
      0,
    );
    expect(readFileSync(out, "utf-8")).toBe(rebuilt);
  });
});

describe("--match-published (regen-themes.yml parameter parity)", () => {
  it("rebuilds an auto-expanded theme (meta.depth 2) at the expanded parameters directly", async () => {
    writeFileSync(out, serialize(withDepth(2, grown(3))));
    const { calls, buildFn } = fakeBuild([serialize(withDepth(2, grown(4)))]);
    expect(await run(["--match-published"], buildFn)).toBe(0);
    expect(calls).toEqual([{ depth: 2, seedsCount: 10, width: 12 }]);
    expect(stderr).toMatch(/match-published: published build has depth 2/);
  });

  it("keeps depth 1 for a depth-1 theme whose rebuild passes the gate, even when sparse (< 15 nodes)", async () => {
    writeFileSync(out, faText());
    const { calls, buildFn } = fakeBuild([faText()]);
    expect(await run(["--match-published"], buildFn)).toBe(0);
    expect(calls).toEqual([{ depth: 1, seedsCount: 5, width: 8 }]);
  });

  it("expands once when the depth-1 rebuild is refused, and publishes the expanded build", async () => {
    writeFileSync(out, faText());
    const good = serialize(withDepth(2, grown(3)));
    const { calls, buildFn } = fakeBuild([weak(), good]);
    expect(await run(["--match-published"], buildFn)).toBe(0);
    expect(calls).toEqual([
      { depth: 1, seedsCount: 5, width: 8 },
      { depth: 2, seedsCount: 10, width: 12 },
    ]);
    expect(stderr).toMatch(/auto-expand: first pass refused by the publish guard/);
    expect(readFileSync(out, "utf-8")).toBe(good);
  });

  it("exits 6 with the published file intact when the expanded rebuild is refused too", async () => {
    writeFileSync(out, faText());
    const { calls, buildFn } = fakeBuild([weak(), weak(grown(8))]);
    expect(await run(["--match-published"], buildFn)).toBe(EXIT_REGRESSION_REFUSED);
    expect(calls).toHaveLength(2);
    expect(readFileSync(out, "utf-8")).toBe(faText());
  });
});

describe("--auto-expand trigger (theme-on-demand.yml)", () => {
  it("expands a dense first pass that would fail the publication gate (not only < 15 nodes)", async () => {
    const first = weak(grown(7)); // 21 nodes, 0 lineage relations: the LoRA depth-1 shape
    const { calls, buildFn } = fakeBuild([first, serialize(grown(8))]);
    expect(await run(["--auto-expand"], buildFn)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(stderr).toMatch(
      /auto-expand: first pass \(21 nodes \/ \d+ edges\) would be blocked by the publication gate \(.*lineage_relation_count failed/,
    );
  });

  it("does not expand a dense first pass that passes the gate", async () => {
    const { calls, buildFn } = fakeBuild([serialize(grown(3))]);
    expect(await run(["--auto-expand"], buildFn)).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("still expands a sparse first pass, but keeps it when the retry would be blocked (LIN-18)", async () => {
    const { calls, buildFn } = fakeBuild([faText(), weak(grown(10))]);
    expect(await run(["--auto-expand"], buildFn)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(stderr).toMatch(/auto-expand retry would be blocked .*keeping the initial lineage/);
    expect(readFileSync(out, "utf-8")).toBe(faText());
  });
});
