/**
 * R2-32 (design 41): workflow contract of the LLM-free conference lineage.
 *
 * - conference-lineage-regen.yml is dispatch-only, needs no LLM secret, and
 *   runs editionLineageCli.ts with the same parameters as collect-weekly.yml
 *   (parameter parity: neither passes size flags, so both use the CLI
 *   defaults — the R2-37 lesson that two workflows building the same
 *   artifact with different parameters replace a published graph with a
 *   smaller one);
 * - both carry the same evidence env (S2 key, arXiv HTML switches);
 * - exit 6 (publish guard) is surfaced, and the regenerated lineages plus
 *   the caches the build wrote are packaged and promoted.
 */
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, readWorkflowRawText, type YamlDoc } from "./helpers.js";

function jobNamed(doc: YamlDoc, jobId: string): YamlDoc {
  const found = jobsOf(doc).find(([id]) => id === jobId);
  if (!found) throw new Error(`job "${jobId}" not found`);
  return found[1];
}

function stepNamed(job: YamlDoc, stepName: string): YamlDoc {
  const step = (job.steps as YamlDoc[]).find((s) => s.name === stepName);
  if (!step) throw new Error(`step ${JSON.stringify(stepName)} not found`);
  return step;
}

const CLI = "apps/pipeline/src/lineage/conference/editionLineageCli.ts";
const REGEN = "conference-lineage-regen.yml";
const WEEKLY = "collect-weekly.yml";
const CACHES = [
  "data/state/lineage-cache/s2_references.json",
  "data/state/lineage-cache/arxiv_html_contexts.json",
  "data/state/lineage-cache/conference_seeds.json",
];

function regenStep() {
  return stepNamed(
    jobNamed(readWorkflow(REGEN), "generate"),
    "Regenerate requested conference lineages",
  );
}
function weeklyStep() {
  return stepNamed(
    jobNamed(readWorkflow(WEEKLY), "generate"),
    "Regenerate eligible conference lineages",
  );
}

/** The flags of every editionLineageCli invocation in a run script. */
function invocations(run: string): string[] {
  const joined = run.replace(/\\\n\s*/g, " ");
  return joined
    .split("\n")
    .filter((l) => l.includes(CLI))
    .map((l) =>
      l
        .slice(l.indexOf(CLI) + CLI.length)
        .replace(/\|\|.*$/, "")
        .trim(),
    );
}

describe("R2-32 conference lineage workflows", () => {
  it("conference-lineage-regen.yml is dispatch-only with a required conferences input", () => {
    const doc = readWorkflow(REGEN);
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    expect(doc.on.workflow_dispatch.inputs.conferences.required).toBe(true);
    expect(doc.on.workflow_dispatch.inputs.allow_shrink.default).toBe(false);
    expect(doc.concurrency.group).toBe("regen-themes");
  });

  it("never reads an LLM key or switch", () => {
    for (const text of [readWorkflowRawText(REGEN), JSON.stringify(weeklyStep())]) {
      expect(text).not.toMatch(/GROQ|GEMINI|PAPERPILOT_LINEAGE_LLM|CONFERENCE_LINEAGE_LLM/);
    }
  });

  it("builds with the same CLI parameters in both workflows (parity)", () => {
    const regen = invocations(regenStep().run);
    const weekly = invocations(weeklyStep().run);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash expansion from the workflow's run: script, not a JS template literal.
    expect(regen).toEqual(['--conference "$conf" ${guard_flags[@]+"${guard_flags[@]}"}']);
    expect(weekly).toEqual(['--conference "$conf"']);
    for (const flags of [...regen, ...weekly]) {
      expect(flags).not.toMatch(/--(seeds|parents|children|s2-venue|allow-incomplete)\b/);
    }
  });

  it("passes the same evidence env in both workflows", () => {
    const keys = [
      "PAPERPILOT_S2_API_KEY",
      "PAPERPILOT_ARXIV_HTML",
      "PAPERPILOT_ARXIV_HTML_MAX_FETCHES",
      "PAPERPILOT_OPENALEX_EMAIL",
    ];
    for (const k of keys) {
      expect(regenStep().env?.[k], k).toBeDefined();
      expect(weeklyStep().env?.[k], k).toBe(regenStep().env?.[k]);
    }
  });

  it("surfaces publish-guard refusals and keeps the published file on every failure", () => {
    const run: string = regenStep().run;
    expect(run).toMatch(/6\) refused=\$\(\(refused \+ 1\)\)/);
    expect(run).toContain("published kept");
  });

  it("packages and promotes the lineages and the caches the build wrote", () => {
    const pkg = stepNamed(
      jobNamed(readWorkflow(REGEN), "generate"),
      "Package exact conference lineage candidate",
    ).run as string;
    const promote = stepNamed(
      jobNamed(readWorkflow(REGEN), "promote"),
      "Validate and promote from the latest develop tip",
    ).run as string;
    for (const c of CACHES) {
      expect(pkg).toContain(c);
      expect(promote).toContain(c);
      expect(readWorkflowRawText(WEEKLY)).toContain(c);
    }
    expect(pkg).toContain("data/published/*/lineage.json");
    expect(promote).toContain("promote conference");
  });

  it("collect-weekly refreshes only conferences that already carry an edition lineage", () => {
    expect(weeklyStep().run).toContain('"paperpilot.lineage.conference.edition"');
  });
});
