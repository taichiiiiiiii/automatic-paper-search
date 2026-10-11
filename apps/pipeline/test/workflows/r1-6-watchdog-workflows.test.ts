/**
 * R1-6 (design 50 P1-1/P1-4, design 52 §8) workflow contracts:
 *  - alert.yml: dispatch-only, develop-only, issues: write only, no
 *    checkout and no secrets; inputs `status` (problem|resolved) and
 *    `summary` reach the shell only via env; one open `watchdog` issue is
 *    commented on rather than a new one opened each time;
 *  - conference-watch.yml: dispatch-only (the Worker cron is the clock —
 *    no GitHub `schedule:`), runs groupsCli --write, commits the pending
 *    file through the bot commit-push pattern only on a material change,
 *    and opens/updates one `conference-watch` issue only for NEW editions;
 *    never publishes;
 *  - the Worker (apps/api/src/watchdog) names these exact files and every
 *    workflow it watches exists.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, workflowsDir, type YamlDoc } from "./helpers.js";

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

const PENDING = "data/state/conference-watch/pending-editions-v1.json";

describe("alert.yml (R1-6)", () => {
  const doc = readWorkflow("alert.yml");
  const issue = job(doc, "issue");

  it("is workflow_dispatch only with status (problem|resolved) and summary inputs", () => {
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual(["status", "summary"]);
    expect(inputs.status.type).toBe("choice");
    expect(inputs.status.options).toEqual(["problem", "resolved"]);
    expect(inputs.summary.required).toBe(true);
  });

  it("is develop-only, issues: write only, no checkout and no secrets", () => {
    expect(issue.if).toBe("github.ref == 'refs/heads/develop'");
    expect(issue.permissions).toEqual({ issues: "write" });
    const raw = JSON.stringify(doc);
    expect(raw).not.toContain("secrets.");
    expect(raw).not.toContain("actions/checkout@");
  });

  it("does not cancel a queued alert", () => {
    expect(doc.concurrency).toEqual({ group: "watchdog-alert", "cancel-in-progress": false });
  });

  it("passes the inputs via env and comments on the single open watchdog issue", () => {
    const s = issue.steps[0];
    expect(s.env.STATUS).toBe("${{ inputs.status }}");
    expect(s.env.SUMMARY).toBe("${{ inputs.summary }}");
    expect(s.env.GH_TOKEN).toBe("${{ github.token }}");
    const run = s.run as string;
    expect(run).toContain("label=watchdog");
    expect(run).toContain('gh issue list --label "$label" --state open --limit 1');
    expect(run).toContain('gh issue comment "$num" --body-file "$body"');
    expect(run).toContain(
      'gh issue create --title "PaperPilot 本番の見張り: 問題あり" --label "$label"',
    );
    expect(run).toContain('gh issue close "$num"');
    // the body @mentions the owner so GitHub sends a participating (e-mail) notification
    expect(s.env.OWNER).toBe("${{ github.repository_owner }}");
    expect(run).toContain("@%s");
  });
});

describe("conference-watch.yml (R1-6 / R3)", () => {
  const doc = readWorkflow("conference-watch.yml");
  const w = job(doc, "watch");

  it("is workflow_dispatch only — the Worker cron dispatches it, no GitHub schedule", () => {
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
  });

  it("is develop-only with contents+issues write, checking out develop", () => {
    expect(w.if).toBe("github.ref == 'refs/heads/develop'");
    expect(w.permissions).toEqual({ contents: "write", issues: "write" });
    const checkout = (w.steps as YamlDoc[]).find(
      (s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"),
    );
    expect(checkout.with.ref).toBe("develop");
    expect(doc.concurrency).toEqual({ group: "conference-watch", "cancel-in-progress": false });
  });

  it("runs groupsCli with --write and tolerates source_blocked (exit 3)", () => {
    const run = step(w, "Run the new-edition watcher (OpenReview /groups)").run as string;
    expect(run).toContain(
      "pnpm exec tsx apps/pipeline/src/conference/watch/groupsCli.ts --write || rc=$?",
    );
    const fail = step(w, "Fail on watcher error");
    expect(fail.if).toBe("steps.watch.outputs.rc != '0' && steps.watch.outputs.rc != '3'");
  });

  it("commits the pending file via commit-push only on a material change", () => {
    const diff = step(w, "Diff pending editions").run as string;
    expect(diff).toContain("del(.last_seen_at)");
    const commit = step(w, "Commit pending editions to develop");
    expect(commit.if).toBe("steps.diff.outputs.changed == 'true'");
    expect(commit.run).toContain("apps/pipeline/src/release/cli.ts commit-push");
    expect(commit.run).toContain(PENDING);
    expect(commit.env.GIT_AUTHOR_NAME).toBe("PaperPilot Bot");
  });

  it("opens/updates one conference-watch issue only for new pending editions", () => {
    const s = step(w, "Open or update the approval issue");
    expect(s.if).toBe("steps.diff.outputs.new_ids != ''");
    expect(s.env.NEW_IDS).toBe("${{ steps.diff.outputs.new_ids }}");
    const run = s.run as string;
    expect(run).toContain("label=conference-watch");
    expect(run).toContain('gh issue list --label "$label" --state open --limit 1');
    expect(run).toContain('select(.status == "pending_approval")');
    // R3-4: one approve -> build command per edition (official listing) …
    expect(run).toContain(
      "pnpm exec tsx apps/pipeline/src/conference/watch/approveCli.ts --edition \\(.edition_id) --execute",
    );
    // … and the arXiv on-demand fallback only where no official adapter exists.
    expect(run).toContain('if .proceedings_adapter == "none" then');
    expect(run).toContain("gh workflow run conference-on-demand.yml --ref develop");
  });

  it("points at an approve CLI that exists and refuses to publish by itself", () => {
    const root = getRepoRoot();
    const cli = readFileSync(
      join(root, "apps/pipeline/src/conference/watch/approveCli.ts"),
      "utf-8",
    );
    expect(cli).toContain("export function runApproveCli");
    expect(cli).not.toMatch(/git (commit|push)|release\/cli\.ts (promote|package)/);
  });

  it("never publishes: no promote, package, release or Pages job", () => {
    const raw = JSON.stringify(doc);
    expect(raw).not.toMatch(/release\/cli\.ts (promote|package)/);
    expect(raw).not.toContain("pages-release.yml");
    expect(raw).not.toContain("data/published");
    expect(jobsOf(doc).map(([id]) => id)).toEqual(["watch"]);
  });
});

describe("the Worker watchdog (apps/api/src/watchdog) matches these workflows", () => {
  const root = getRepoRoot();
  const scheduled = readFileSync(join(root, "apps/api/src/watchdog/scheduled.ts"), "utf-8");
  const checks = readFileSync(join(root, "apps/api/src/watchdog/checks.ts"), "utf-8");

  it("dispatches alert.yml and conference-watch.yml by these exact names", () => {
    expect(scheduled).toContain('ALERT_WORKFLOW_FILE = "alert.yml"');
    expect(scheduled).toContain('CONFERENCE_WATCH_WORKFLOW_FILE = "conference-watch.yml"');
    expect(scheduled).toMatch(/status: decision\.action,\s*summary,/);
  });

  it("every workflow it watches exists, and it does not watch alert.yml", () => {
    const block = checks.match(/WATCHDOG_WORKFLOWS: readonly string\[\] = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const names = [...block![1]!.matchAll(/"([^"]+\.yml)"/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const n of ["pages.yml", "tests.yml", "data-audit.yml", "regen-themes.yml"]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("alert.yml");
    for (const n of names) expect(existsSync(join(workflowsDir(), n))).toBe(true);
  });
});
