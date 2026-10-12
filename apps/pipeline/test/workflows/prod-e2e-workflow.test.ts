/**
 * prod-e2e.yml (post-release browser smoke) contracts:
 *  - it follows every workflow that can publish to Cloudflare Pages
 *    (every caller of pages-release.yml, plus pages-rollback) on develop;
 *  - it is observe-only: contents: read for the browser job, no secrets,
 *    no Cloudflare, no deploy/rollback/release calls, not wired into any
 *    release as a blocking job;
 *  - it targets PUBLIC_ORIGIN with the `@prod` subset (`e2e:prod` greps
 *    @prod and excludes @prod-crawl) and the crawler only on schedule /
 *    explicit dispatch;
 *  - a failure goes through alert.yml's `prod-e2e` channel (one issue,
 *    resolved on the next green run).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { PUBLIC_ORIGIN } from "@paperpilot/core/site";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_WORKFLOW_FILES,
  jobsOf,
  readAllWorkflows,
  readWorkflow,
  type YamlDoc,
} from "./helpers.js";

const doc = readWorkflow("prod-e2e.yml");
const jobs = new Map(jobsOf(doc));
const smoke: YamlDoc = jobs.get("smoke");
const notify: YamlDoc = jobs.get("notify");
const step = (j: YamlDoc, prefix: string): YamlDoc => {
  const s = (j.steps as YamlDoc[]).find((x) => String(x.name ?? "").startsWith(prefix));
  if (!s) throw new Error(`step ${prefix} not found`);
  return s;
};

describe("prod-e2e.yml triggers", () => {
  it("runs after every Pages-publishing workflow completes on develop", () => {
    const wr = doc.on.workflow_run;
    expect(wr.types).toEqual(["completed"]);
    expect(wr.branches).toEqual(["develop"]);
    const all = readAllWorkflows();
    const releaseCallers = EXPECTED_WORKFLOW_FILES.filter((f) =>
      jobsOf(all.get(f)).some(([, j]) => j.uses === "./.github/workflows/pages-release.yml"),
    ).map((f) => all.get(f).name as string);
    expect(releaseCallers.length).toBeGreaterThanOrEqual(5);
    expect([...wr.workflows].sort()).toEqual([...releaseCallers, "pages-rollback"].sort());
  });

  it("only smokes successful runs, on develop", () => {
    expect(smoke.if).toContain("github.ref == 'refs/heads/develop'");
    expect(smoke.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(Object.keys(doc.on).sort()).toEqual(["schedule", "workflow_dispatch", "workflow_run"]);
  });
});

describe("prod-e2e.yml is observe-only", () => {
  it("browser job is contents: read, with no secrets and no Cloudflare access", () => {
    expect(smoke.permissions).toEqual({ contents: "read" });
    const raw = JSON.stringify(doc);
    expect(raw).not.toContain("secrets.");
    expect(raw).not.toContain("CLOUDFLARE_");
    expect(raw).not.toContain("wrangler");
    expect(raw).not.toMatch(/pages-release\.yml"|pages-rollback\.yml"/);
    expect(smoke.environment).toBeUndefined();
  });

  it("no release workflow waits on it (it can never block or roll back a release)", () => {
    const all = readAllWorkflows();
    for (const f of EXPECTED_WORKFLOW_FILES) {
      if (f === "prod-e2e.yml") continue;
      for (const [id, j] of jobsOf(all.get(f))) {
        expect(String(j.uses ?? ""), `${f} job ${id}`).not.toContain("prod-e2e.yml");
      }
      expect(Object.keys(all.get(f).on ?? {}), f).not.toContain("workflow_run");
    }
  });

  it("smokes PUBLIC_ORIGIN with the @prod subset; the crawler only on schedule/dispatch", () => {
    expect(doc.env.PUBLIC_ORIGIN).toBe(PUBLIC_ORIGIN);
    const prod = step(smoke, "Browser smoke (@prod)");
    expect(prod.env.E2E_BASE_URL).toBe("${{ env.PUBLIC_ORIGIN }}");
    expect(prod.run).toBe("pnpm --filter @paperpilot/web e2e:prod");
    const crawl = step(smoke, "Broken-link crawl (@prod-crawl)");
    expect(crawl.if).toBe("github.event_name == 'schedule' || inputs.crawl == true");
    expect(crawl.run).toBe("pnpm --filter @paperpilot/web e2e:crawl");
    const pkg = JSON.parse(readFileSync(join(getRepoRoot(), "apps/web/package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["e2e:prod"]).toBe(
      "playwright test --grep @prod --grep-invert @prod-crawl --project desktop-chromium --project mobile-chromium",
    );
    expect(pkg.scripts["e2e:crawl"]).toContain("--grep @prod-crawl");
  });
});

describe("prod-e2e.yml notification", () => {
  it("dispatches alert.yml on the prod-e2e channel; resolves only an open issue", () => {
    expect(notify.needs).toBe("smoke");
    expect(notify.if).toContain("always()");
    expect(notify.permissions).toEqual({ actions: "write", issues: "read" });
    const s = notify.steps[0];
    expect(s.env.RESULT).toBe("${{ needs.smoke.result }}");
    const run = s.run as string;
    expect(run).toContain(
      'gh workflow run alert.yml --ref develop -f status=problem -f channel=prod-e2e -f summary="$summary"',
    );
    expect(run).toContain("gh issue list --label prod-e2e --state open");
    expect(run).toContain(
      'gh workflow run alert.yml --ref develop -f status=resolved -f channel=prod-e2e -f summary="$summary"',
    );
  });

  it("alert.yml accepts the prod-e2e channel with its own label", () => {
    const alert = readWorkflow("alert.yml");
    const channel = alert.on.workflow_dispatch.inputs.channel;
    expect(channel.options).toEqual(["watchdog", "prod-e2e"]);
    const run = jobsOf(alert)[0]![1].steps[0].run as string;
    expect(run).toContain("label=prod-e2e");
  });
});
