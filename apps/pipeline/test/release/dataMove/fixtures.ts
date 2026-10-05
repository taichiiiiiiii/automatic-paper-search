/**
 * Shared throwaway-repo fixture for the data-move test suite. Builds a
 * real `git init` repository in `os.tmpdir()` (never the real repo, never
 * a mock git adapter) with one representative file per rule class, mirroring
 * `apps/pipeline/test/release/promote.test.ts`'s fixture pattern.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitAdapter, git } from "../../../src/release/git/gitAdapter.js";

export const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export const adapter = createGitAdapter();

export function gitRun(cwd: string, args: string[]): string {
  return git(adapter, cwd, args, { env: GIT_ENV });
}

export const CONFIG_YAML_FIXTURE = `output:
  csv:
    enabled: true
    dir: paperpilot/output
    encoding: utf-8-sig
  json:
    enabled: true
    dir: paperpilot/output

incremental:
  enabled: true
  seen_ids_file: paperpilot/data/seen_ids.json
  max_age_days: 14

logging:
  level: INFO
  file: paperpilot/logs/paperpilot.log
`;

export const CONFIG_DAILY_WATCH_YAML_FIXTURE = `output:
  csv:
    enabled: true
    dir: paperpilot/output/daily
    encoding: utf-8-sig

incremental:
  enabled: true
  seen_ids_file: paperpilot/data/seen_ids.daily.json
  run_history_file: paperpilot/data/run_history.daily.jsonl
  max_age_days: 3

logging:
  level: INFO
  file: paperpilot/logs/paperpilot-daily.log
`;

export const GITIGNORE_FIXTURE = `node_modules/

paperpilot/data/lineage-cache/*
!paperpilot/data/lineage-cache/classifications.json

paperpilot/data/unarxive/
`;

export const LAYOUT_FIXTURE = `export type LayoutMode = "legacy" | "p5";
export const LAYOUT_MODE: LayoutMode = "legacy";
`;

const WORKFLOW_FIXTURE = (name: string) =>
  `name: ${name}\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n`;

function write(repo: string, rel: string, content: string): void {
  const full = join(repo, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

export interface FixtureRepo {
  base: string;
  repo: string;
}

/**
 * One file per rule class (plus a few extra per class to catch
 * cross-rule-collision bugs), the two config files, `.gitignore`, the
 * layout module, and a staged-workflow swap with a to-be-overwritten name,
 * a to-be-added name, and the three to-be-deleted names. Commits
 * everything and returns the repo path plus its own parent temp dir (for
 * cleanup).
 */
export function buildFixtureRepo(): FixtureRepo {
  const base = mkdtempSync(join(tmpdir(), "paperpilot-datamove-world-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  gitRun(repo, ["init", "--initial-branch=develop"]);

  // docs/ — delete (gated + ungated), stay, moves of every kind.
  write(repo, "docs/daily/papers.json", "[]\n");
  write(repo, "docs/search-index.json", "{}\n");
  write(repo, "docs/design/39-x.md", "# design\n");
  write(repo, "docs/QWEN_IMPLEMENTER.md", "# qwen\n");
  write(repo, "docs/assets/favicon.svg", "<svg/>\n");
  write(repo, "docs/assets/app.js", "console.log('app');\n");
  write(repo, "docs/index.html", "<html>top</html>\n");
  write(repo, "docs/how-it-works/index.html", "<html>how</html>\n");
  write(repo, "docs/lineage/index.html", "<html>lineage</html>\n");
  write(repo, "docs/themes/index.html", "<html>themes</html>\n");
  write(repo, "docs/themes/themes-manifest.json", "{}\n");
  write(repo, "docs/themes/flash-attention/lineage.json", '{"nodes":[]}\n');
  write(repo, "docs/conferences.json", "[]\n");
  write(repo, "docs/paper-details-v1/00.json", "{}\n");
  write(repo, "docs/search-paper-ids-v1/0000.json", "{}\n");
  write(repo, "docs/cvpr-2026/index.html", "<html>cvpr</html>\n");
  write(repo, "docs/cvpr-2026/paper-links.html", "<html>links</html>\n");
  write(repo, "docs/cvpr-2026/lineage.html", "<html>lineage</html>\n");
  write(repo, "docs/cvpr-2026/deep.html", "<html>deep</html>\n");
  write(repo, "docs/cvpr-2026/papers.json", '{"papers":[]}\n');
  write(repo, "docs/cvpr-2026/lineage.json", '{"nodes":[]}\n');
  write(repo, "docs/iclr-2026/deep-123.json", "{}\n");
  write(repo, "docs/iclr-2026/deep-manifest.json", "{}\n");

  // paperpilot/data — stay, bulk move, individual moves.
  write(repo, "paperpilot/data/.gitkeep", "");
  write(repo, "paperpilot/data/sol-abstract-local-v1.json", "{}\n");
  write(repo, "paperpilot/data/lineage-cache/classifications.json", "{}\n");
  write(repo, "paperpilot/data/seen_ids.json", "{}\n");
  write(repo, "paperpilot/data/lineage_denylist.json", "[]\n");

  // paperpilot/output — stay (top-level only), everything else moves.
  write(repo, "paperpilot/output/.gitkeep", "");
  write(repo, "paperpilot/output/daily/.gitkeep", "");
  write(repo, "paperpilot/output/cvpr-2026/summary.csv", "a,b\n1,2\n");

  // paperpilot/{config.yaml,config.daily-watch.yaml,.env.example}
  write(repo, "paperpilot/config.yaml", CONFIG_YAML_FIXTURE);
  write(repo, "paperpilot/config.daily-watch.yaml", CONFIG_DAILY_WATCH_YAML_FIXTURE);
  write(repo, "paperpilot/.env.example", "PAPERPILOT_S2_API_KEY=\n");

  // Outside every managed root.
  write(repo, "apps/web/README.md", "# web\n");

  // .gitignore + the layout module.
  write(repo, ".gitignore", GITIGNORE_FIXTURE);
  write(repo, "packages/core/src/layout/index.ts", LAYOUT_FIXTURE);

  // Staged workflows: tests.yml is overwritten, legacy-redirects.yml is
  // brand new, the three named workflows are deleted.
  write(repo, ".github/workflows/tests.yml", WORKFLOW_FIXTURE("tests (python)"));
  write(repo, ".github/workflows/ts-ci.yml", WORKFLOW_FIXTURE("ts-ci"));
  write(repo, ".github/workflows/publish.yml", WORKFLOW_FIXTURE("publish"));
  write(
    repo,
    ".github/workflows/paper-slides-on-demand.yml",
    WORKFLOW_FIXTURE("paper-slides-on-demand"),
  );
  write(repo, ".github/workflows-p5/tests.yml", WORKFLOW_FIXTURE("tests (node)"));
  write(repo, ".github/workflows-p5/legacy-redirects.yml", WORKFLOW_FIXTURE("legacy-redirects"));

  gitRun(repo, ["add", "."]);
  gitRun(repo, ["commit", "-m", "legacy fixture tree"]);

  return { base, repo };
}

export function cleanupFixtureRepo(fixture: FixtureRepo): void {
  rmSync(fixture.base, { recursive: true, force: true });
}
