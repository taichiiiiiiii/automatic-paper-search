/**
 * Dispatch-input contract for the `gh workflow run <file> -f name=…`
 * commands the repo itself writes (workflow steps, and the operator
 * commands printed by apps/pipeline, e.g. conference-watch's issue text and
 * approveCli's arXiv fallback for conference-on-demand.yml): every `-f`
 * name must be a declared `workflow_dispatch` input of the target workflow
 * and every required input without a default must be passed, or the
 * printed command fails with "Unexpected inputs provided" / a missing
 * required input. The Worker's own dispatches (theme-on-demand.yml, the
 * watchdog's alert/conference-watch/theme-feeds) are pinned by
 * apps/api/test/workflow-dispatch-contract.test.ts from the real code path.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { describe, expect, it } from "vitest";
import { listWorkflowFiles, readWorkflow, readWorkflowRawText } from "./helpers.js";

interface Command {
  where: string;
  workflow: string;
  names: string[];
}

const GH_RUN = /gh workflow run ([A-Za-z0-9_.-]+\.ya?ml)([^\n`]*)/g;

function commandsIn(where: string, text: string): Command[] {
  return [...text.matchAll(GH_RUN)].map((m) => ({
    where,
    workflow: m[1]!,
    names: [...m[2]!.matchAll(/(?:^|\s)-f\s+([A-Za-z_][A-Za-z0-9_-]*)=/g)].map((f) => f[1]!),
  }));
}

function allCommands(): Command[] {
  const out: Command[] = [];
  for (const file of listWorkflowFiles()) {
    out.push(...commandsIn(`.github/workflows/${file}`, readWorkflowRawText(file)));
  }
  const src = join(getRepoRoot(), "apps", "pipeline", "src");
  for (const rel of readdirSync(src, { recursive: true, encoding: "utf8" })) {
    if (!rel.endsWith(".ts")) continue;
    // Join `...` + `...` template-literal continuations into one command.
    const text = readFileSync(join(src, rel), "utf8").replace(/`\s*\+\s*`/g, "");
    out.push(...commandsIn(`apps/pipeline/src/${rel}`, text));
  }
  return out;
}

function inputsOf(workflow: string): Record<string, { required?: boolean; default?: unknown }> {
  const doc = readWorkflow(workflow);
  const on = doc.on ?? doc[true as unknown as string];
  expect(on?.workflow_dispatch, `${workflow} must accept workflow_dispatch`).toBeDefined();
  return on.workflow_dispatch?.inputs ?? {};
}

describe("gh workflow run commands match the target workflow_dispatch inputs", () => {
  const commands = allCommands();

  it("finds the known dispatch commands (conference-on-demand fallbacks, regen-retry)", () => {
    const targets = new Set(commands.map((c) => c.workflow));
    expect(targets).toContain("conference-on-demand.yml");
    expect(targets).toContain("regen-themes.yml");
    expect(
      commands.filter((c) => c.workflow === "conference-on-demand.yml").length,
    ).toBeGreaterThanOrEqual(2);
  });

  for (const cmd of commands) {
    it(`${cmd.where} -> ${cmd.workflow} (${cmd.names.join(", ") || "no inputs"})`, () => {
      expect(listWorkflowFiles()).toContain(cmd.workflow);
      const declared = inputsOf(cmd.workflow);
      for (const name of cmd.names) {
        expect(
          declared,
          `${cmd.where}: -f ${name} is not an input of ${cmd.workflow}`,
        ).toHaveProperty(name);
      }
      for (const [name, spec] of Object.entries(declared)) {
        if (spec.required && spec.default === undefined) {
          expect(
            cmd.names,
            `${cmd.where}: required input ${name} of ${cmd.workflow} not passed`,
          ).toContain(name);
        }
      }
    });
  }
});
