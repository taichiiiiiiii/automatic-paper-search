/**
 * `approveCli` (R3-4, design 52 §8.6): approve a pending edition -> build
 * its catalog from the official source with one command.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { describe, expect, it } from "vitest";
import { displayCopy, planApproval, renderCommand } from "../../../src/conference/watch/approve.js";
import {
  EDITIONS_CONFIG_PATH,
  PENDING_PATH,
  QUALITY_PATH,
  resolveEdition,
  runApproveCli,
} from "../../../src/conference/watch/approveCli.js";
import {
  EditionsConfigSchema,
  PendingEditionsFileSchema,
} from "../../../src/conference/watch/groups.js";
import { refreshCommandsFor } from "../../../src/release/promoteHooks.js";

const ROOT = "/repo";
const AS_OF = "2026-10-11T08:11:35Z";
const CONFIG = readFileSync(join(getRepoRoot(), EDITIONS_CONFIG_PATH), "utf-8");
const PENDING = JSON.stringify({
  schema_version: "conference-pending-editions-v1",
  last_check: { status: "ok", checked_at: "2026-10-11T05:07:18.494Z", detail: "x" },
  editions: [
    {
      edition_id: "iclr-2025",
      venue_key: "iclr",
      year: 2025,
      display_name: "ICLR 2025",
      openreview_group_id: "ICLR.cc/2025/Conference",
      phase: "announced",
      status: "pending_approval",
      auto_publish: false,
      first_seen_at: "2026-10-11T05:07:18.494Z",
      last_seen_at: "2026-10-11T05:07:18.494Z",
      listed: true,
      start_date: "2025-04-24",
      location: "Singapore",
      proceedings_adapter: "iclr-proceedings",
      proceedings_hint: "h",
    },
  ],
});

function files(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [join(ROOT, PENDING_PATH)]: PENDING,
    [join(ROOT, EDITIONS_CONFIG_PATH)]: CONFIG,
    [join(ROOT, QUALITY_PATH)]: JSON.stringify({ as_of: AS_OF }),
    ...extra,
  };
}

function cli(argv: string[], fs = files()) {
  const lines: string[] = [];
  const runs: Array<{ argv: string[]; env: Record<string, string> }> = [];
  let failAt = -1;
  const code = runApproveCli(argv, {
    root: ROOT,
    readFile: (p) => {
      const v = fs[p];
      if (v === undefined) throw new Error(`missing ${p}`);
      return v;
    },
    exists: (p) => p in fs,
    print: (l) => lines.push(l),
    run: (a, env) => {
      runs.push({ argv: a, env });
      return runs.length - 1 === failAt ? 1 : 0;
    },
  });
  return { code, out: lines.join("\n"), runs, setFail: (i: number) => (failAt = i) };
}

describe("committed watch files stay parseable with the new adapters", () => {
  it("config and pending state validate", () => {
    const root = getRepoRoot();
    const cfg = EditionsConfigSchema.parse(JSON.parse(CONFIG));
    const adapters = Object.fromEntries(
      cfg.venues.map((v) => [v.venue_key, v.proceedings_adapter]),
    );
    expect(adapters).toMatchObject({
      neurips: "neurips-proceedings",
      iclr: "iclr-proceedings",
      eccv: "ecva",
    });
    PendingEditionsFileSchema.parse(JSON.parse(readFileSync(join(root, PENDING_PATH), "utf-8")));
  });
});

describe("planApproval", () => {
  const edition = resolveEdition("iclr-2025", PENDING, CONFIG);

  it("collects from the adapter, scaffolds copy, builds summary, then promote's refresh chain", () => {
    expect(edition).not.toBeNull();
    const plan = planApproval(edition!, { tree: ROOT, asOf: AS_OF });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const lines = plan.commands.map(renderCommand);
    expect(lines[0]).toBe(
      "PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx apps/pipeline/src/conference/site/cli.ts " +
        "--conference iclr-2025 --venue ICLR --kind proceedings --year 2025 --site iclr",
    );
    expect(lines[1]).toContain(
      "apps/pipeline/src/conference/scaffold/cli.ts --conference iclr-2025",
    );
    expect(plan.commands[1]?.env?.DISPLAY).toBe("ICLR 2025");
    expect(lines[2]).toBe(
      "pnpm exec tsx apps/pipeline/src/catalog/buildSummaryCli.ts --conference iclr-2025",
    );
    // The tail IS promote's refresh table (minus the install), so the two cannot drift.
    const refresh = refreshCommandsFor("conference", ROOT, AS_OF).filter((a) => a[1] !== "install");
    expect(plan.commands.slice(3).map((c) => c.argv)).toEqual(refresh);
  });

  it("says abstracts are withheld for listing-only adapters", () => {
    expect(displayCopy(edition!, "iclr-proceedings").lede).toContain(
      "要旨は出典のライセンスにより掲載しません",
    );
    expect(displayCopy(edition!, "acl-anthology").lede).toContain("要旨を収録");
  });

  it("derives non-pending editions from the config slug template", () => {
    expect(resolveEdition("emnlp-2026", null, CONFIG)).toEqual({
      edition_id: "emnlp-2026",
      venue_key: "emnlp",
      year: 2026,
      display_name: "EMNLP 2026",
      proceedings_adapter: "acl-anthology",
    });
    expect(resolveEdition("foo-2026", null, CONFIG)).toBeNull();
  });

  it("maps every adapter to its collector", () => {
    const at = (
      id: string,
      adapter?: Parameters<typeof planApproval>[1]["adapter"],
      extra = {},
    ) => {
      const e = resolveEdition(id, null, CONFIG);
      const p = planApproval(e!, { tree: ROOT, asOf: AS_OF, adapter, ...extra });
      return p.ok ? renderCommand(p.commands[0]!) : `refused: ${p.reason}`;
    };
    expect(at("emnlp-2026")).toContain(
      "acl/cli.ts --conference emnlp-2026 --venue EMNLP --xml-id 2026.emnlp",
    );
    expect(at("cvpr-2027")).toContain(
      "cvf/cli.ts --conference cvpr-2027 --venue CVPR --cvf-id CVPR2027 --listing-only",
    );
    expect(at("neurips-2026")).toContain("--kind proceedings --year 2026 --site neurips");
    expect(at("eccv-2026")).toContain("--kind ecva --year 2026");
    expect(at("icml-2027")).toMatch(/^refused: pmlr needs --pmlr-volume/);
    expect(at("icml-2027", undefined, { pmlrVolume: 320 })).toContain(
      "pmlr/cli.ts --conference icml-2027 --venue ICML --volume 320",
    );
    expect(at("colm-2026")).toMatch(/^refused: .*conference-on-demand\.yml/);
    expect(at("neurips-2026", "virtual-export")).toMatch(/^refused: .*D6/);
    expect(
      at("neurips-2026", "virtual-export", { allowVirtualSite: true, virtualInput: "x.csv" }),
    ).toContain(
      "--kind virtual-export --year 2026 --site neurips --allow-virtual-site --input x.csv",
    );
  });
});

describe("runApproveCli", () => {
  it("dry run prints the plan and runs nothing", () => {
    const r = cli(["--edition", "iclr-2025"]);
    expect(r.code).toBe(0);
    expect(r.runs).toEqual([]);
    expect(r.out).toContain("adapter iclr-proceedings");
    expect(r.out).toContain(`--as-of ${AS_OF}`);
    expect(r.out).toContain("dry run");
  });

  it("--execute runs every step in order with its env", () => {
    const r = cli(["--edition", "iclr-2025", "--execute"]);
    expect(r.code).toBe(0);
    expect(r.runs).toHaveLength(7);
    expect(r.runs[0]?.env).toEqual({ PAPERPILOT_OUTPUT_ROOT: "data/inputs" });
    expect(r.runs[6]?.argv).toContain(
      "apps/pipeline/src/lineage/quality/buildLineageQualityCli.ts",
    );
  });

  it("refuses unknown editions and a quality file without as_of", () => {
    expect(cli(["--edition", "nope-2026"]).code).toBe(1);
    const noAsOf = cli(["--edition", "iclr-2025"], files({ [join(ROOT, QUALITY_PATH)]: "{}" }));
    expect(noAsOf.code).toBe(1);
    expect(noAsOf.out).toContain("no as_of");
  });

  it("rejects an unknown --adapter as a usage error", () => {
    expect(() => cli(["--edition", "iclr-2025", "--adapter", "openreview"])).toThrow(
      /--adapter must be one of/,
    );
  });
});
