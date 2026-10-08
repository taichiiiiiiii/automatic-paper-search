/**
 * p5-plan.md §2 A7 assertions 1, 2, 3, 7, 10, 12 — the injection-shaped
 * and least-privilege checks that apply uniformly across every staged
 * workflow.
 */
import { describe, expect, it } from "vitest";
import {
  allRunStrings,
  allUsesStrings,
  EXPECTED_WORKFLOW_FILES,
  jobsOf,
  PENDING_UNPINNED_ACTIONS,
  readAllWorkflows,
  readCompositeAction,
  readWorkflow,
  type YamlDoc,
} from "./helpers.js";

const docs = readAllWorkflows();

describe("assertion 1: no GitHub Actions expression interpolation inside any run: string", () => {
  // Implemented as the strict superset the plan names (inputs.*,
  // github.event.inputs.*, secrets.*, needs.*.outputs.*): every value a
  // run: step needs is routed through env: instead, so this also closes
  // off any OTHER expression form (e.g. a bare `${{ github.sha }}`) that
  // the narrower, pattern-by-pattern version would miss.
  for (const file of EXPECTED_WORKFLOW_FILES) {
    it(`${file}: no run: string contains \${{`, () => {
      const doc = docs.get(file);
      for (const run of allRunStrings(doc)) {
        expect(run).not.toContain("${{");
      }
    });
  }
});

describe("assertion 2: every uses: is pinned to a 40-hex SHA, a local ref, or an explicit PENDING exception", () => {
  const shaPinned = /@[0-9a-f]{40}(\s|$|#)/;
  for (const file of EXPECTED_WORKFLOW_FILES) {
    it(`${file}`, () => {
      const doc = docs.get(file);
      for (const uses of allUsesStrings(doc)) {
        const isLocal = uses.startsWith("./");
        const isPinned = shaPinned.test(`${uses} `);
        const isPendingException = PENDING_UNPINNED_ACTIONS.has(uses);
        expect(
          isLocal || isPinned || isPendingException,
          `unpinned, non-local uses: ${uses} in ${file}`,
        ).toBe(true);
      }
    });
  }

  it("the composite action's own uses: are pinned too", () => {
    const action = readCompositeAction();
    for (const step of action.runs.steps as Array<Record<string, unknown>>) {
      if (typeof step.uses === "string") {
        expect(shaPinned.test(`${step.uses} `)).toBe(true);
      }
    }
  });

  it("PENDING_UNPINNED_ACTIONS has no stale entries (every listed ref is still actually unpinned and present)", () => {
    const allUses = new Set<string>();
    for (const file of EXPECTED_WORKFLOW_FILES) {
      for (const uses of allUsesStrings(docs.get(file))) allUses.add(uses);
    }
    for (const pending of PENDING_UNPINNED_ACTIONS) {
      expect(
        allUses.has(pending),
        `PENDING_UNPINNED_ACTIONS lists ${pending}, not found in any staged workflow`,
      ).toBe(true);
    }
  });
});

describe("assertion 3: top-level permissions: {} with per-job minimum permissions", () => {
  for (const file of EXPECTED_WORKFLOW_FILES) {
    it(`${file}: top-level permissions is {}`, () => {
      const doc = docs.get(file);
      expect(doc.permissions).toEqual({});
    });

    it(`${file}: every job declares its own permissions`, () => {
      const doc = docs.get(file);
      for (const [jobId, job] of jobsOf(doc)) {
        // A job that only calls a reusable workflow (`uses:`) declares
        // permissions at the call site instead of a `runs-on` job body.
        if (job.uses) {
          expect(
            job.permissions,
            `${file} job ${jobId} (reusable call) has no permissions:`,
          ).toBeDefined();
          continue;
        }
        expect(job.permissions, `${file} job ${jobId} has no permissions:`).toBeDefined();
      }
    });
  }
});

describe('assertion 7: every "generate" job has persist-credentials: false and contents: read', () => {
  const filesWithGenerate = EXPECTED_WORKFLOW_FILES.filter((f) => {
    const doc = docs.get(f);
    return jobsOf(doc).some(([id]) => id === "generate");
  });

  it("at least one staged workflow actually has a generate job (sanity)", () => {
    expect(filesWithGenerate.length).toBeGreaterThan(0);
  });

  for (const file of filesWithGenerate) {
    it(`${file}`, () => {
      const doc = docs.get(file);
      const [, generateJob] = jobsOf(doc).find(([id]) => id === "generate") as [string, YamlDoc];
      expect(generateJob.permissions?.contents).toBe("read");
      const steps: Array<Record<string, unknown>> = generateJob.steps;
      const checkoutSteps = steps.filter(
        (s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"),
      );
      expect(checkoutSteps.length).toBeGreaterThan(0);
      for (const step of checkoutSteps) {
        expect((step.with as Record<string, unknown> | undefined)?.["persist-credentials"]).toBe(
          false,
        );
      }
    });
  }
});

describe("assertion 10: no python, uv, setup-python or .github/scripts/*.sh anywhere", () => {
  // Checked against each individual PARSED `run:`/`uses:` string, not
  // the raw YAML text and not JSON.stringify(parsedDoc):
  //   - the raw text also contains comments (this file's own module-doc
  //     prose legitimately mentions "the pre-P5 Python tests.yml"),
  //     which would be a false positive the plan's assertion never
  //     intended to catch;
  //   - JSON-escaping a multi-line `run:` block turns each real newline
  //     into the two literal characters `\` + `n`, which can glue the
  //     end of one line onto the start of the next
  //     (`...pipefail\npython...`) and defeat a `\b`-anchored regex.
  // A parsed `run:`/`uses:` string has neither problem: the YAML parser
  // already stripped comments, and a block-scalar `run:` keeps real
  // newline characters.
  for (const file of EXPECTED_WORKFLOW_FILES) {
    it(`${file}`, () => {
      const doc = docs.get(file);
      const candidates = [...allRunStrings(doc), ...allUsesStrings(doc)];
      for (const text of candidates) {
        expect(text).not.toMatch(/\bpython\d?\b/i);
        expect(text).not.toMatch(/\buv\b/);
        expect(text).not.toContain("setup-python");
        expect(text).not.toMatch(/\.github\/scripts\/[^"\s]*\.sh/);
      }
    });
  }
});

describe("assertion 12: legacy-redirects.yml is dispatch-only with a confirm input", () => {
  const doc = readWorkflow("legacy-redirects.yml");

  it("only workflow_dispatch triggers it", () => {
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
  });

  it("requires a confirm input", () => {
    const confirmInput = doc.on.workflow_dispatch.inputs.confirm;
    expect(confirmInput).toBeDefined();
    expect(confirmInput.required).toBe(true);
  });
});
