/**
 * M2 of the P5 tier-A review (pass 1): pages-rollback.yml trusted the
 * Deployment payload's `cf_deployment_id` without validation before
 * writing it to `$GITHUB_OUTPUT` (a newline-carrying payload value could
 * smuggle an extra `key=value` line past a later, differently-scoped
 * job), and never confirmed a deployment id's own recorded `commit_hash`
 * matched `target_sha` before the mutating rollback call. This pins:
 *   - the `cf_deployment_id` regex check happens before the output write;
 *   - both outputs are written together, from already-validated shell
 *     variables, in one `printf` (never two separate unconditional
 *     `echo ... >> $GITHUB_OUTPUT` lines that could be interleaved by an
 *     injected line in between);
 *   - a verification step runs between "Setup pnpm" and the rollback
 *     step itself, calling the new `cf-verify-deployment` subcommand.
 */
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

const doc = readWorkflow("pages-rollback.yml");

function validateStep(): YamlDoc {
  const [, job] = jobsOf(doc).find(([id]) => id === "validate_target") as [string, YamlDoc];
  const steps: YamlDoc[] = job.steps;
  const step = steps.find((s) => s.id === "validate");
  if (!step) throw new Error('validate_target job step with id "validate" not found');
  return step;
}

describe("M2: pages-rollback.yml's validate step writes GITHUB_OUTPUT safely", () => {
  it("regex-checks cf_deployment_id before any $GITHUB_OUTPUT write", () => {
    const run: string = validateStep().run;
    const regexIdx = run.indexOf('"$cf_deployment_id" =~ ^[A-Za-z0-9-]{1,64}$');
    // The ACTUAL write (`>> "$GITHUB_OUTPUT"`), not just any mention of
    // the string — this step's own explanatory comment legitimately
    // says "$GITHUB_OUTPUT" in prose before the real write happens.
    const outputIdx = run.indexOf('>> "$GITHUB_OUTPUT"');
    expect(regexIdx, "cf_deployment_id format check not found").toBeGreaterThanOrEqual(0);
    expect(outputIdx, "no $GITHUB_OUTPUT write found").toBeGreaterThanOrEqual(0);
    expect(regexIdx).toBeLessThan(outputIdx);
  });

  it("writes target_sha and cf_deployment_id together from one printf, never two unconditional echoes", () => {
    const run: string = validateStep().run;
    expect(run).toContain("printf 'target_sha=%s\\ncf_deployment_id=%s\\n'");
    expect(run).not.toMatch(/echo "target_sha=\$TARGET_SHA" >> "\$GITHUB_OUTPUT"/);
    expect(run).not.toMatch(/echo "cf_deployment_id=\$cf_deployment_id" >> "\$GITHUB_OUTPUT"/);
  });
});

describe("M2: the rollback job verifies the Cloudflare deployment before rolling back", () => {
  it('a "cf-verify-deployment" step runs after Setup pnpm and before the rollback step', () => {
    const [, rollbackJob] = jobsOf(doc).find(([id]) => id === "rollback") as [string, YamlDoc];
    const steps: YamlDoc[] = rollbackJob.steps;
    const setupIdx = steps.findIndex(
      (s) => typeof s.uses === "string" && s.uses.includes("setup-pnpm"),
    );
    const verifyIdx = steps.findIndex(
      (s) => typeof s.run === "string" && s.run.includes("cf-verify-deployment"),
    );
    const rollbackIdx = steps.findIndex((s) => s.id === "rollback");
    expect(setupIdx, "Setup pnpm step not found").toBeGreaterThanOrEqual(0);
    expect(verifyIdx, "cf-verify-deployment step not found").toBeGreaterThanOrEqual(0);
    expect(rollbackIdx, "rollback step (id: rollback) not found").toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeLessThan(verifyIdx);
    expect(verifyIdx).toBeLessThan(rollbackIdx);
  });

  it("the verify step passes the SAME deployment id and target SHA the rollback step itself uses", () => {
    const [, rollbackJob] = jobsOf(doc).find(([id]) => id === "rollback") as [string, YamlDoc];
    const steps: YamlDoc[] = rollbackJob.steps;
    const verifyStep = steps.find(
      (s) => typeof s.run === "string" && s.run.includes("cf-verify-deployment"),
    );
    expect(verifyStep?.env?.DEPLOYMENT_ID).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
      "${{ needs.validate_target.outputs.cf_deployment_id }}",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
    expect(verifyStep?.env?.TARGET_SHA).toBe("${{ needs.validate_target.outputs.target_sha }}");
  });
});
