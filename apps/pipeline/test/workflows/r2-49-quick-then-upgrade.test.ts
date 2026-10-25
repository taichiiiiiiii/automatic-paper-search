/**
 * R2-49: a requested field is published as soon as the quick depth-1 build
 * is released; a small result (depth 1, < 30 papers) is then rebuilt
 * expanded by one more run of the same workflow (`expand=true`), which
 * never chains again and only replaces the published lineage through the
 * publish guard.
 */
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

const doc = readWorkflow("theme-on-demand.yml");
const jobs = Object.fromEntries(jobsOf(doc)) as Record<string, YamlDoc>;
const generateSteps = jobs.generate.steps as YamlDoc[];
const stepNamed = (prefix: string) =>
  generateSteps.find((s) => String(s.name).startsWith(prefix)) as YamlDoc;

describe("theme-on-demand.yml quick-then-upgrade (R2-49)", () => {
  it("has a boolean `expand` input defaulting to false that the Worker never sends", () => {
    expect(doc.on.workflow_dispatch.inputs.expand).toMatchObject({
      type: "boolean",
      default: false,
      required: false,
    });
  });

  it("builds quick (auto-expand) unless expand, and expanded (depth 2) only when expand", () => {
    const quick = stepNamed("Generate theme lineage");
    const expanded = stepNamed("Generate expanded theme lineage");
    expect(quick.if).toBe("inputs.expand != true");
    expect(expanded.if).toBe("inputs.expand == true");
    expect(quick.run).toContain("--auto-expand");
    expect(expanded.run).toContain("--depth 2 --seeds 10 --width 12");
    expect(expanded.run).not.toContain("--auto-expand");
    for (const f of ["--allow-shrink", "--allow-reaudit", "--allow-incomplete"]) {
      expect(expanded.run).not.toContain(f);
    }
  });

  it("flags a depth-1 result under 30 papers for upgrade, never on the upgrade run itself", () => {
    expect(jobs.generate.outputs.upgrade).toBe("${{ steps.candidate.outputs.upgrade }}");
    const freeze = stepNamed("Freeze candidate metadata");
    expect(freeze.env.EXPAND).toBe("${{ inputs.expand }}");
    expect(freeze.run).toContain('if [ "$EXPAND" != "true" ]');
    expect(freeze.run).toContain("depth===1&&d.nodes.length<30");
    expect(freeze.run).toContain('echo "upgrade=$upgrade" >> "$GITHUB_OUTPUT"');
  });

  it("the upgrade job runs after a successful release and only dispatches expand=true", () => {
    const upgrade = jobs.upgrade;
    expect(upgrade.needs).toEqual(["generate", "release"]);
    expect(upgrade.if).toBe(
      "needs.release.result == 'success' && needs.generate.outputs.upgrade == 'true'",
    );
    expect(upgrade.permissions).toEqual({ actions: "write" });
    const run = (upgrade.steps as YamlDoc[]).map((s) => s.run ?? "").join("\n");
    expect(run).toContain("gh workflow run theme-on-demand.yml");
    expect(run).toContain("-f expand=true");
    expect(run).toContain('-f theme="$THEME_INPUT"');
  });
});
