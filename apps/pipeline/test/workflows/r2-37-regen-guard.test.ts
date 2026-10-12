/**
 * R2-37 workflow contracts (2026-10-12 incident: regen-themes.yml rebuilt the
 * auto-expanded, published Low-Rank Adaptation theme at plain depth 1 and
 * the release replaced it with a blocked build):
 *  - regen-themes.yml builds with the same generation parameters as
 *    theme-on-demand.yml, plus --match-published;
 *  - the guard overrides (allow_shrink / allow_reaudit) are boolean inputs,
 *    default off, passed only through env;
 *  - exit 6 (refused by the publish guard) is counted, listed in the job
 *    summary and fails `verdict` after promote;
 *  - theme-on-demand.yml keeps --auto-expand and never passes a guard override.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_REGRESSION_REFUSED } from "../../src/lineage/theme/publishGuard.js";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

function job(doc: YamlDoc, id: string): YamlDoc {
  const found = jobsOf(doc).find(([j]) => j === id);
  if (!found) throw new Error(`job ${id} not found`);
  return found[1];
}
function step(j: YamlDoc, name: string): YamlDoc {
  const s = (j.steps as YamlDoc[]).find((x) => x.name === name);
  if (!s) throw new Error(`step ${name} not found`);
  return s;
}

/** The flags of the theme CLI call in a run script (continuations joined). */
function themeCliFlags(run: string): string[] {
  const joined = run.replace(/\\\n\s*/g, " ");
  const line = joined.split("\n").find((l) => l.includes("apps/pipeline/src/lineage/theme/cli.ts"));
  if (!line) throw new Error("theme CLI call not found");
  return line
    .slice(line.indexOf("cli.ts") + "cli.ts".length)
    .trim()
    .split(/\s+/);
}
/** `--flag value` pairs that shape the graph (compared across workflows). */
const PARAM_FLAGS = [
  "--depth",
  "--seeds",
  "--width",
  "--since-year",
  "--primary-source",
  "--llm-strict",
];
function generationParams(flags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of PARAM_FLAGS) {
    const i = flags.indexOf(f);
    if (i >= 0) out[f] = flags[i + 1] as string;
  }
  return out;
}

const regenDoc = readWorkflow("regen-themes.yml");
const regenGen = job(regenDoc, "generate");
const regenStep = step(regenGen, "Regenerate requested themes");
const regenRun = regenStep.run as string;
const onDemandDoc = readWorkflow("theme-on-demand.yml");
const onDemandRun = step(job(onDemandDoc, "generate"), "Generate theme lineage").run as string;

describe("regen-themes.yml builds like theme-on-demand.yml (R2-37 parity)", () => {
  it("uses the same generation parameters as the on-demand build", () => {
    const regen = generationParams(themeCliFlags(regenRun));
    const onDemand = generationParams(themeCliFlags(onDemandRun));
    expect(Object.keys(onDemand).sort()).toEqual([...PARAM_FLAGS].sort());
    expect(regen).toEqual(onDemand);
  });

  it("passes --match-published (rebuild auto-expanded themes expanded; expand on a gate failure)", () => {
    expect(themeCliFlags(regenRun)).toContain("--match-published");
  });

  it("theme-on-demand keeps --auto-expand and never passes a guard override", () => {
    const flags = themeCliFlags(onDemandRun);
    expect(flags).toContain("--auto-expand");
    for (const f of ["--allow-shrink", "--allow-reaudit", "--allow-incomplete"]) {
      expect(onDemandRun).not.toContain(f);
    }
  });
});

describe("regen-themes.yml publish-guard handling (R2-37)", () => {
  const inputs = regenDoc.on.workflow_dispatch.inputs;

  it("exposes allow_shrink / allow_reaudit as boolean inputs defaulting to false", () => {
    for (const name of ["allow_shrink", "allow_reaudit"]) {
      expect(inputs[name]).toMatchObject({ type: "boolean", default: false, required: false });
    }
  });

  it("reads the overrides only through env and maps them to the CLI flags", () => {
    expect(regenStep.env.ALLOW_SHRINK).toBe("${{ inputs.allow_shrink }}");
    expect(regenStep.env.ALLOW_REAUDIT).toBe("${{ inputs.allow_reaudit }}");
    expect(regenRun).not.toContain("inputs.allow_");
    expect(regenRun).toMatch(/"\$ALLOW_SHRINK" = "true" \] && guard_flags\+=\(--allow-shrink\)/);
    expect(regenRun).toMatch(/"\$ALLOW_REAUDIT" = "true" \] && guard_flags\+=\(--allow-reaudit\)/);
    expect(themeCliFlags(regenRun)).toContain('"${guard_flags[@]}"');
  });

  it(`counts exit ${EXIT_REGRESSION_REFUSED} as refused, with an ::error:: line and a job-summary entry`, () => {
    expect(regenRun).toContain(`"$rc" -eq ${EXIT_REGRESSION_REFUSED}`);
    expect(regenRun).toMatch(/refused\+=\("\$theme"\)/);
    expect(regenRun).toMatch(/::error::regen refused for \$theme/);
    expect(regenRun).toMatch(/refused by the publish guard: \$\{#refused\[@\]\}/);
    expect(regenRun).toContain('echo "refused=${#refused[@]}"');
    expect(regenGen.outputs.refused).toBe("${{ steps.regen.outputs.refused }}");
  });

  it("fails `verdict` (after promote) when any rebuild was refused", () => {
    const verdict = job(regenDoc, "verdict");
    expect(verdict.needs).toEqual(["generate", "promote"]);
    expect(verdict.if).toBe("always()");
    const v = verdict.steps[0];
    expect(v.env.REFUSED).toBe("${{ needs.generate.outputs.refused }}");
    expect(v.run).toMatch(/if \[ "\$\{REFUSED:-0\}" != 0 \]; then[\s\S]*?exit 1/);
  });

  it("the regen script is valid bash", () => {
    const dir = mkdtempSync(join(tmpdir(), "r2-37-wf-"));
    const file = join(dir, "regen.sh");
    writeFileSync(file, regenRun);
    const r = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("the guard-flag mapping behaves (true -> flag, false/empty -> none)", () => {
    const snippet = regenRun.slice(
      regenRun.indexOf("guard_flags=()"),
      regenRun.indexOf("results_dir="),
    );
    const probe = (shrink: string, reaudit: string): string =>
      spawnSync(
        "bash",
        ["-c", `set -euo pipefail\n${snippet}\necho "n=\${#guard_flags[@]} \${guard_flags[*]:-}"`],
        {
          encoding: "utf8",
          env: { ALLOW_SHRINK: shrink, ALLOW_REAUDIT: reaudit, PATH: process.env.PATH },
        },
      ).stdout.trim();
    expect(probe("false", "false")).toBe("n=0");
    expect(probe("", "")).toBe("n=0");
    expect(probe("true", "false")).toBe("n=1 --allow-shrink");
    expect(probe("true", "true")).toBe("n=2 --allow-shrink --allow-reaudit");
  });
});
