/**
 * H1 of the P5 tier-A review (pass 1): general contract — every
 * `needs.<job>.` reference anywhere inside a job (its own `if:`,
 * `outputs:`, `env:`, `with:`, ...) must name a job actually listed in
 * that SAME job's own `needs:`. The `needs` context in a real GitHub
 * Actions run only contains direct dependencies, so a reference to a job
 * missing from `needs:` silently evaluates to `''` rather than erroring
 * at parse time — exactly how pages-release.yml's `smoke` job (H1) read
 * `needs.build.outputs.artifact_name` while only declaring
 * `needs: [admit, deploy]`.
 */
import { describe, expect, it } from "vitest";
import { EXPECTED_WORKFLOW_FILES, jobsOf, readAllWorkflows, type YamlDoc } from "./helpers.js";

const docs = readAllWorkflows();

/** Every string leaf anywhere under `node` (job body, recursively). */
function collectAllStrings(node: unknown, seen: Set<unknown> = new Set()): string[] {
  if (typeof node === "string") return [node];
  if (node === null || typeof node !== "object") return [];
  if (seen.has(node)) return [];
  seen.add(node);
  const found: string[] = [];
  if (Array.isArray(node)) {
    for (const item of node) found.push(...collectAllStrings(item, seen));
    return found;
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    found.push(...collectAllStrings(value, seen));
  }
  return found;
}

function needsDeclaredBy(job: YamlDoc): Set<string> {
  if (job.needs === undefined) return new Set();
  return new Set(Array.isArray(job.needs) ? job.needs : [job.needs]);
}

const NEEDS_REF_RE = /\bneeds\.([A-Za-z0-9_-]+)\./g;

function needsReferencedBy(job: YamlDoc): Set<string> {
  const referenced = new Set<string>();
  for (const text of collectAllStrings(job)) {
    NEEDS_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null = NEEDS_REF_RE.exec(text);
    while (m !== null) {
      referenced.add(m[1] as string);
      m = NEEDS_REF_RE.exec(text);
    }
  }
  return referenced;
}

describe("every needs.<job>. reference inside a job is listed in that job's own needs:", () => {
  let sawAtLeastOneReference = false;

  for (const file of EXPECTED_WORKFLOW_FILES) {
    const doc = docs.get(file);
    for (const [jobId, job] of jobsOf(doc)) {
      it(`${file} job "${jobId}"`, () => {
        const declared = needsDeclaredBy(job);
        const referenced = needsReferencedBy(job);
        if (referenced.size > 0) sawAtLeastOneReference = true;
        for (const ref of referenced) {
          expect(
            declared.has(ref),
            `${file} job "${jobId}" references needs.${ref}. but its needs: is ${JSON.stringify([
              ...declared,
            ])}`,
          ).toBe(true);
        }
      });
    }
  }

  it("sanity: at least one needs.<job>. reference was actually found (the extractor isn't silently matching nothing)", () => {
    expect(sawAtLeastOneReference).toBe(true);
  });
});
