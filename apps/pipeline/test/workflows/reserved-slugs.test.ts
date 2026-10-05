/**
 * conference-on-demand.yml's `RESERVED_SLUGS` env (the dispatch-time
 * reserved-path guard) must equal `@paperpilot/core/slug`'s
 * `RESERVED_CONFERENCE_SLUGS` — the single source of truth for every
 * reserved slug EXCEPT `cvpr-2026`, which is deliberately kept out of
 * that shared set (per that module's own doc comment: existing CLIs
 * operate on it, so it stays a workflow-local addition) — plus that one
 * extra entry. Derived from the core export rather than a second
 * hand-maintained literal here, so the two can never silently drift
 * apart again.
 */
import { RESERVED_CONFERENCE_SLUGS } from "@paperpilot/core/slug";
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

/** `RESERVED_CONFERENCE_SLUGS` (core) plus the one workflow-only addition. */
const EXPECTED_RESERVED_SLUGS = new Set([...RESERVED_CONFERENCE_SLUGS, "cvpr-2026"]);

function workflowReservedSlugs(): Set<string> {
  const doc = readWorkflow("conference-on-demand.yml");
  const [, generateJob] = jobsOf(doc).find(([id]) => id === "generate") as [string, YamlDoc];
  const steps: YamlDoc[] = generateJob.steps;
  const step = steps.find((s) => typeof s.env?.RESERVED_SLUGS === "string");
  if (!step) throw new Error("no step with env.RESERVED_SLUGS found in conference-on-demand.yml");
  return new Set((step.env.RESERVED_SLUGS as string).split(/\s+/).filter(Boolean));
}

describe("conference-on-demand.yml's RESERVED_SLUGS equals core's RESERVED_CONFERENCE_SLUGS + cvpr-2026", () => {
  it("sanity: the core export is non-empty and does not itself include cvpr-2026", () => {
    expect(RESERVED_CONFERENCE_SLUGS.size).toBeGreaterThan(0);
    expect(RESERVED_CONFERENCE_SLUGS.has("cvpr-2026")).toBe(false);
  });

  it("the workflow's RESERVED_SLUGS set matches exactly (no missing, no extra entries)", () => {
    const workflow = workflowReservedSlugs();
    const expected = EXPECTED_RESERVED_SLUGS;

    const missing = [...expected].filter((s) => !workflow.has(s));
    const extra = [...workflow].filter((s) => !expected.has(s));

    expect(missing, `RESERVED_SLUGS is missing: ${JSON.stringify(missing)}`).toEqual([]);
    expect(extra, `RESERVED_SLUGS has unexpected extra entries: ${JSON.stringify(extra)}`).toEqual(
      [],
    );
  });
});
