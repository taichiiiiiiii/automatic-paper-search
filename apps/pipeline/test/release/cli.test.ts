/**
 * End-to-end smoke tests for `src/release/cli.ts`'s argv wiring, run via
 * `tsx` as a real child process (the way GitHub Actions would invoke it) —
 * not a unit test of the ported logic itself (covered by each module's
 * own test file).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "release", "cli.ts");
// tsx is a workspace-root devDependency (hoisted by pnpm), not installed
// per-package, so resolve it from the repo root rather than this package.
const TSX = join(__dirname, "..", "..", "..", "..", "node_modules", ".bin", "tsx");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function runCli(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(TSX, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...GIT_ENV, ...env },
    timeout: 30_000,
  });
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperpilot-release-cli-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

it("commit-push subcommand pushes a staged change to a local remote", () => {
  const remote = join(base, "remote.git");
  mkdirSync(remote);
  runGit(remote, ["init", "--bare", "--initial-branch=develop"]);
  const local = join(base, "local");
  mkdirSync(local);
  runGit(local, ["init", "--initial-branch=develop"]);
  runGit(local, ["remote", "add", "origin", remote]);
  writeFileSync(join(local, "README.md"), "seed\n");
  runGit(local, ["add", "README.md"]);
  runGit(local, ["commit", "-m", "seed"]);
  runGit(local, ["push", "-u", "origin", "develop"]);
  mkdirSync(join(local, "docs", "themes", "t"), { recursive: true });
  writeFileSync(join(local, "docs", "themes", "t", "lineage.json"), "{}\n");

  const output = runCli(local, ["commit-push", "data(test): cli push", "docs/themes/"], {
    COMMIT_PUSH_NO_SLEEP: "1",
  });
  expect(output).toContain("push succeeded");
  const log = runGit(remote, ["log", "--oneline"]);
  expect(log.split("\n").length).toBe(2);
}, 30_000); // real tsx subprocess + git operations; the 5s default can flake under load

it("package subcommand copies only changed files under the included path", () => {
  const repo = join(base, "repo");
  mkdirSync(repo);
  runGit(repo, ["init", "--initial-branch=develop"]);
  mkdirSync(join(repo, "docs", "themes"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "baseline\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "seed"]);
  mkdirSync(join(repo, "docs", "themes", "new"), { recursive: true });
  writeFileSync(join(repo, "docs", "themes", "new", "lineage.json"), '{"new":true}\n');

  const candidate = join(base, "candidate");
  const output = runCli(repo, ["package", candidate, "docs/themes"]);
  expect(output).toContain("packaged 1 generated file");
  expect(readFileSync(join(candidate, "docs/themes/new/lineage.json"), "utf-8")).toContain("new");
});

// LOW: packageCandidate resolves included paths AND runs every git command
// against the repo root, so running it from a SUBDIRECTORY of the repo
// (process.cwd() !== the repo root) must not silently miscompute diffs —
// --repo-root makes the real root explicit instead of always trusting cwd.
it("package subcommand works when invoked from a subdirectory via --repo-root", () => {
  const repo = join(base, "repo");
  mkdirSync(repo);
  runGit(repo, ["init", "--initial-branch=develop"]);
  mkdirSync(join(repo, "docs", "themes"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "baseline\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "seed"]);
  mkdirSync(join(repo, "docs", "themes", "new"), { recursive: true });
  writeFileSync(join(repo, "docs", "themes", "new", "lineage.json"), '{"new":true}\n');

  const subdir = join(repo, "docs");
  const candidate = join(base, "candidate-subdir");
  const output = runCli(subdir, ["package", "--repo-root", repo, candidate, "docs/themes"]);
  expect(output).toContain("packaged 1 generated file");
  expect(readFileSync(join(candidate, "docs/themes/new/lineage.json"), "utf-8")).toContain("new");
});

it("promote subcommand prints source_sha and changed, and appends to GITHUB_OUTPUT", () => {
  const remote = join(base, "remote.git");
  mkdirSync(remote);
  runGit(remote, ["init", "--bare", "--initial-branch=develop"]);
  const checkout = join(base, "checkout");
  mkdirSync(checkout);
  runGit(checkout, ["init", "--initial-branch=develop"]);
  runGit(checkout, ["remote", "add", "origin", remote]);
  mkdirSync(join(checkout, "docs", "themes"), { recursive: true });
  writeFileSync(join(checkout, "docs", "themes", "manifest.json"), "{}\n");
  runGit(checkout, ["add", "."]);
  runGit(checkout, ["commit", "-m", "seed"]);
  runGit(checkout, ["push", "-u", "origin", "develop"]);
  const baseSha = runGit(checkout, ["rev-parse", "HEAD"]);

  const candidate = join(base, "candidate");
  mkdirSync(join(candidate, "docs", "themes", "new-theme"), { recursive: true });
  writeFileSync(join(candidate, "docs", "themes", "new-theme", "lineage.json"), "{}\n");

  const githubOutput = join(base, "github-output.txt");
  writeFileSync(githubOutput, "");

  const output = runCli(
    checkout,
    ["promote", "test-only", candidate, "data(test): cli promote", "docs/themes"],
    {
      PAPERPILOT_PROMOTION_TEST_MODE: "1",
      PROMOTE_NO_SLEEP: "1",
      PROMOTE_MAX_ATTEMPTS: "2",
      PROMOTE_BASE_SHA: baseSha,
      GITHUB_OUTPUT: githubOutput,
    },
  );
  expect(output).toContain("source_sha=");
  expect(output).toContain("changed=true");
  expect(readFileSync(githubOutput, "utf-8")).toContain("changed=true");
}, 30_000); // real tsx subprocess + a worktree-based promotion; the 5s default can flake under load

// M3 of the P4 review: release/cli.ts used to pass every attempt-count env
// var straight through `Number.parseInt(..., 10)` with no validation at
// all — "" / "abc" / "-1" / "0" would reach `commitAndPush`/`promote` as
// `NaN`/a non-positive count instead of failing loudly the way
// `promote-generated.sh`'s own `[[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] ||
// die ...` does. These exercise the real CLI subprocess so `die()`'s
// `process.exit(1)` is actually observed, not just unit-tested in
// isolation.
function expectCliDies(cwd: string, args: string[], env: Record<string, string>): string {
  try {
    runCli(cwd, args, env);
    throw new Error("expected the CLI to exit non-zero, but it succeeded");
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    expect(err.status).toBe(1);
    return String(err.stderr ?? "");
  }
}

it("PROMOTE_MAX_ATTEMPTS must be a positive integer (matches promote-generated.sh's regex)", () => {
  const repo = join(base, "repo");
  mkdirSync(repo);
  runGit(repo, ["init", "--initial-branch=develop"]);
  const candidate = join(base, "candidate");
  mkdirSync(candidate);
  writeFileSync(join(candidate, "x.json"), "{}\n");

  // 5 real CLI subprocess spawns (one per `bad` value); under `pnpm -r`'s
  // parallel workspace-package execution this has been observed to
  // exceed vitest's 5000ms default timeout from CPU contention alone
  // (each spawn is sub-second in isolation) -- an explicit timeout is
  // the fix, since the work itself is the real cost, not a hang.
  for (const bad of ["0", "-1", "abc", "1.5", "01"]) {
    const stderr = expectCliDies(repo, ["promote", "test-only", candidate, "msg", "x.json"], {
      PROMOTE_MAX_ATTEMPTS: bad,
    });
    expect(stderr).toContain("PROMOTE_MAX_ATTEMPTS must be positive");
  }
}, 20_000);

it("COMMIT_PUSH_MAX_ATTEMPTS must be a positive integer (the shell never checks this, but an unvalidated 0/NaN would break every retry)", () => {
  const repo = join(base, "repo");
  mkdirSync(repo);
  runGit(repo, ["init", "--initial-branch=develop"]);
  writeFileSync(join(repo, "x.txt"), "a\n");

  for (const bad of ["0", "-3", "nope"]) {
    const stderr = expectCliDies(repo, ["commit-push", "msg", "x.txt"], {
      COMMIT_PUSH_MAX_ATTEMPTS: bad,
    });
    expect(stderr).toContain("COMMIT_PUSH_MAX_ATTEMPTS must be positive");
  }
});

it("PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED must be exactly 0 or 1 (matches package-generated-candidate.sh)", () => {
  const repo = join(base, "repo");
  mkdirSync(repo);
  runGit(repo, ["init", "--initial-branch=develop"]);
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "x.json"), "{}\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "seed"]);
  const candidate = join(base, "candidate-bad-env");

  for (const bad of ["true", "2", "yes"]) {
    const stderr = expectCliDies(repo, ["package", candidate, "docs"], {
      PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED: bad,
    });
    expect(stderr).toContain("PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED must be 0 or 1");
  }
});

it("COMMIT_PUSH_BRANCH='' falls back to develop, matching the shell's :- default substitution", () => {
  const remote = join(base, "remote.git");
  mkdirSync(remote);
  runGit(remote, ["init", "--bare", "--initial-branch=develop"]);
  const local = join(base, "local-empty-branch");
  mkdirSync(local);
  runGit(local, ["init", "--initial-branch=develop"]);
  runGit(local, ["remote", "add", "origin", remote]);
  writeFileSync(join(local, "README.md"), "seed\n");
  runGit(local, ["add", "README.md"]);
  runGit(local, ["commit", "-m", "seed"]);
  runGit(local, ["push", "-u", "origin", "develop"]);
  writeFileSync(join(local, "note.txt"), "x\n");

  const output = runCli(local, ["commit-push", "data(test): empty branch env", "note.txt"], {
    COMMIT_PUSH_NO_SLEEP: "1",
    COMMIT_PUSH_BRANCH: "",
  });
  expect(output).toContain("push succeeded");
  const log = runGit(remote, ["log", "--oneline", "develop"]);
  expect(log.split("\n").length).toBe(2);
}, 30_000);

// ---- p5-plan.md §2 A4: validate bundle / marker / no-skip-gate (real tsx subprocess) ----

function writeLegacyBundle(dir: string): void {
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">';
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><head>${csp}</head></html>`);
  writeFileSync(join(dir, "404.html"), `<!doctype html><html><head>${csp}</head></html>`);
  mkdirSync(join(dir, "iclr-2026"), { recursive: true });
  writeFileSync(join(dir, "iclr-2026", "papers.json"), "[]");
  writeFileSync(join(dir, "conferences.json"), JSON.stringify([{ name: "iclr-2026" }]));
  writeFileSync(join(dir, "search-index.json"), "[]");
  writeFileSync(join(dir, "search-index-v2.json"), "[]");
  writeFileSync(join(dir, "lineage-quality-v1.json"), "{}");
  writeFileSync(join(dir, "sitemap.xml"), '<?xml version="1.0"?><urlset></urlset>');
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "versions.json"), "{}");
  // p5-only required artifacts (Next's static-export postbuild outputs);
  // written unconditionally (harmless extra files under legacy) so this
  // fixture is a valid bundle under BOTH layout modes.
  writeFileSync(join(dir, "_redirects"), "/old /new 301\n");
  writeFileSync(join(dir, "_headers"), "/*\n  Content-Security-Policy: frame-ancestors 'self'\n");
}

it("validate bundle subcommand passes a well-formed bundle with no SHA/HEAD check", () => {
  const dir = join(base, "bundle-ok");
  mkdirSync(dir, { recursive: true });
  writeLegacyBundle(dir);
  const output = runCli(base, ["validate", "bundle", dir]);
  expect(output).toContain("validated");
});

it("validate bundle subcommand fails loudly on a missing required artifact", () => {
  const dir = join(base, "bundle-bad");
  mkdirSync(dir, { recursive: true });
  writeLegacyBundle(dir);
  rmSync(join(dir, "404.html"));
  const stderr = expectCliDies(base, ["validate", "bundle", dir], {});
  expect(stderr).toContain("missing Pages artifact: 404.html");
});

it("marker subcommand writes a byte-identical _paperpilot-deployment.json from env", () => {
  const dir = join(base, "marker-out");
  mkdirSync(dir, { recursive: true });
  const sha = "c".repeat(40);
  const output = runCli(base, ["marker", dir], {
    SOURCE_SHA: sha,
    RELEASE_KIND: "normal",
    REQUEST_ID: "push-1-1",
  });
  expect(output).toContain("wrote");
  const written = readFileSync(join(dir, "_paperpilot-deployment.json"), "utf-8");
  expect(JSON.parse(written)).toEqual({
    release_kind: "normal",
    request_id: "push-1-1",
    schema_version: "paperpilot-deployment-v1",
    source_sha: sha,
  });
  expect(written.endsWith("}\n")).toBe(true);
});

it("marker subcommand dies loudly on a malformed SOURCE_SHA", () => {
  const dir = join(base, "marker-bad");
  mkdirSync(dir, { recursive: true });
  const stderr = expectCliDies(base, ["marker", dir], {
    SOURCE_SHA: "not-a-sha",
    RELEASE_KIND: "normal",
    REQUEST_ID: "",
  });
  expect(stderr).toContain("SOURCE_SHA");
});

// L11 (P5 tier-A review): `requiredShaEnv` (cli.ts) is shared by both
// `cf-deployment-id` and `gh-record` to validate `SOURCE_SHA` before any
// network call -- previously untested by any subcommand. `cf-deployment-id`
// exercises it with the fewest other required env vars; a malformed
// SOURCE_SHA must die BEFORE `getProductionDeploymentId` ever calls
// `fetchImpl` (so this real-subprocess test never touches the network).
it("cf-deployment-id subcommand dies loudly on a malformed SOURCE_SHA (requiredShaEnv), before any network call", () => {
  const repo = join(base, "repo-cf-deployment-id");
  mkdirSync(repo);
  for (const bad of ["not-a-sha", "a".repeat(39), "A".repeat(40), `${"a".repeat(40)}\n`]) {
    const stderr = expectCliDies(repo, ["cf-deployment-id"], {
      CF_ACCOUNT_ID: "acct",
      CF_PROJECT: "proj",
      CF_API_TOKEN: "tok",
      SOURCE_SHA: bad,
    });
    expect(stderr).toContain("SOURCE_SHA must be 40 lowercase hex characters");
  }
});

// LOW (P5 tier-A review round 4): `EnvSpec.require` already treats an
// empty-string env var as missing (`raw === undefined || raw === ""`,
// cli.ts), but this was untested at the CLI level. An empty string is what
// a workflow step produces when a secret/variable is configured but
// resolves empty (e.g. `CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}` with
// the secret unset) -- unlike an *unset* name, `process.env.CF_ACCOUNT_ID`
// is then the string `""`, not `undefined`, so a naive `??`/truthiness-free
// check would let it through to a Cloudflare API URL as a literal empty
// path segment.
it("cf-deployment-id subcommand dies loudly on an empty-string CF_ACCOUNT_ID, before any network call", () => {
  const repo = join(base, "repo-cf-deployment-id-empty-account");
  mkdirSync(repo);
  const stderr = expectCliDies(repo, ["cf-deployment-id"], {
    CF_ACCOUNT_ID: "",
    CF_PROJECT: "proj",
    CF_API_TOKEN: "tok",
    SOURCE_SHA: "a".repeat(40),
  });
  expect(stderr).toContain("CF_ACCOUNT_ID is required");
});

// P5 tier-A review round 2 (survivor fix): previously untested at the
// CLI level. The expected-sha format check runs BEFORE any `requiredEnv`
// call or network access, so this stays within the "no network in
// tests" hard limit even with no CF_* env vars set at all.
it("cf-verify-deployment subcommand dies loudly on a malformed expected-sha, before checking env or any network call", () => {
  const repo = join(base, "repo-cf-verify-deployment");
  mkdirSync(repo);
  for (const bad of ["not-a-sha", "a".repeat(39), "A".repeat(40)]) {
    const stderr = expectCliDies(repo, ["cf-verify-deployment", "dep-1", bad], {});
    expect(stderr).toContain("expected-sha must be 40 lowercase hex characters");
  }
});

it("gh-record subcommand dies loudly on a malformed SOURCE_SHA (requiredShaEnv), before any network call", () => {
  const repo = join(base, "repo-gh-record");
  mkdirSync(repo);
  const stderr = expectCliDies(repo, ["gh-record"], {
    RELEASE_KIND: "normal",
    GITHUB_TOKEN: "tok",
    GITHUB_REPOSITORY: "owner/repo",
    SOURCE_SHA: "not-a-sha",
    CF_DEPLOYMENT_ID: "dep-1",
    ARTIFACT_NAME: "cf-pages-test",
  });
  expect(stderr).toContain("SOURCE_SHA must be 40 lowercase hex characters");
});

// N3 (P5 tier-A review round 2): `pages-rollback.yml`'s "record" step
// never sets ARTIFACT_NAME (no rebuild happens anywhere in a rollback),
// so `ARTIFACT_NAME` must be required for RELEASE_KIND=normal but
// optional for RELEASE_KIND=rollback. Both cases below die before any
// network call (`requiredEnv`/`recordDeployment`'s own validation both
// run before the first `fetch`), so this stays within the "no network
// in tests" hard limit while still exercising the real CLI subprocess.
it("gh-record subcommand requires ARTIFACT_NAME when RELEASE_KIND=normal, before any network call", () => {
  const repo = join(base, "repo-gh-record-normal-no-artifact");
  mkdirSync(repo);
  const stderr = expectCliDies(repo, ["gh-record"], {
    RELEASE_KIND: "normal",
    GITHUB_TOKEN: "tok",
    GITHUB_REPOSITORY: "owner/repo",
    SOURCE_SHA: "a".repeat(40),
    CF_DEPLOYMENT_ID: "dep-1",
    // ARTIFACT_NAME deliberately omitted.
  });
  expect(stderr).toContain("ARTIFACT_NAME is required");
});

it("gh-record subcommand does NOT require ARTIFACT_NAME when RELEASE_KIND=rollback, before any network call", () => {
  const repo = join(base, "repo-gh-record-rollback-no-artifact");
  mkdirSync(repo);
  // CF_DEPLOYMENT_ID is deliberately malformed (recordDeployment's own
  // CF_DEPLOYMENT_ID_RE check, which runs before artifactName's and
  // before any network call) so this test proves the CLI got PAST the
  // missing ARTIFACT_NAME without dying on it -- if rollback still
  // required ARTIFACT_NAME, the stderr below would instead say
  // "ARTIFACT_NAME is required", never reaching this check.
  const stderr = expectCliDies(repo, ["gh-record"], {
    RELEASE_KIND: "rollback",
    GITHUB_TOKEN: "tok",
    GITHUB_REPOSITORY: "owner/repo",
    SOURCE_SHA: "a".repeat(40),
    CF_DEPLOYMENT_ID: "bad id with spaces",
    // ARTIFACT_NAME deliberately omitted.
  });
  expect(stderr).not.toContain("ARTIFACT_NAME");
  expect(stderr).toContain("invalid cfDeploymentId");
});

it("no-skip-gate subcommand passes a clean vitest JSON report and fails a report with a skip", () => {
  const good = join(base, "report-good.json");
  writeFileSync(
    good,
    JSON.stringify({
      numTotalTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{ assertionResults: [{ title: "ok", status: "passed" }] }],
    }),
  );
  const output = runCli(base, ["no-skip-gate", good]);
  expect(output).toContain("clean");

  const bad = join(base, "report-bad.json");
  writeFileSync(
    bad,
    JSON.stringify({
      numTotalTests: 1,
      numPendingTests: 1,
      numTodoTests: 0,
      testResults: [{ assertionResults: [{ title: "skipped one", status: "skipped" }] }],
    }),
  );
  const stderr = expectCliDies(base, ["no-skip-gate", bad], {});
  expect(stderr).toContain("pending");
});

// P5 tier-A review round 3, L1: the release passes one explicit report
// per test package; a package that wrote no report must fail the gate, not
// drop out of it.
it("no-skip-gate fails when one of the named reports is missing, even if the others are clean", () => {
  const good = join(base, "report-present.json");
  writeFileSync(
    good,
    JSON.stringify({
      numTotalTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{ assertionResults: [{ title: "ok", status: "passed" }] }],
    }),
  );
  const missing = join(base, "apps", "new-package", ".vitest-release-report.json");
  const stderr = expectCliDies(base, ["no-skip-gate", good, missing], {});
  expect(stderr).toContain(missing);
});

// P5 tier-A review round 3, L2: REQUIRED_ENV_BY_SUBCOMMAND used to be a
// hand-maintained list next to scattered `requiredEnv(...)` calls, so a new
// `requiredEnv("X")` in a handler silently escaped the workflow env-coverage
// check. Every handler now reads required env only through its own
// `envSpec(...)`, and the exported list is built from those specs. These
// tests pin that there is no other route.
describe("release/cli.ts env specs are the only way a handler requires env (L2)", () => {
  const source = readFileSync(CLI, "utf-8");

  it("every <SPEC>.require/requireSha call names a var its own spec declares", async () => {
    const { ENV_SPECS } = await import("../../src/release/cli.js");
    const specVars = new Map<string, string>();
    for (const m of source.matchAll(/const (\w+) = envSpec\(\s*"([a-z-]+)"/g)) {
      specVars.set(m[1] as string, m[2] as string);
    }
    expect(specVars.size).toBe(Object.keys(ENV_SPECS).length);
    const calls = [...source.matchAll(/(\w+)\.(require|requireSha)\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThan(10);
    for (const [call, receiver, , arg] of calls) {
      const subcommand = specVars.get(receiver as string);
      expect(subcommand, `${call}: receiver is not an envSpec`).toBeDefined();
      const literal = /^\s*"([A-Z0-9_]+)"\s*$/.exec(arg as string);
      expect(literal, `${call}: the env var name must be a plain string literal`).not.toBeNull();
      const spec = ENV_SPECS[subcommand as string];
      expect(
        [...(spec?.required ?? []), ...(spec?.conditional ?? [])],
        `${call}: ${literal?.[1]} is not declared in the "${subcommand}" env spec`,
      ).toContain(literal?.[1]);
    }
  });

  it("no free requiredEnv/requiredShaEnv helper (a second route around the specs) exists", () => {
    expect(source).not.toMatch(/\brequired(Sha)?Env\s*\(/);
  });

  it("every main() subcommand has an env spec (no silent `?? []` default)", async () => {
    const { REQUIRED_ENV_BY_SUBCOMMAND } = await import("../../src/release/cli.js");
    const mainBody = source.slice(source.indexOf("async function main"));
    const cases = [...mainBody.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]).sort();
    expect(cases.length).toBeGreaterThan(5);
    expect(Object.keys(REQUIRED_ENV_BY_SUBCOMMAND).sort()).toEqual(cases);
  });

  it("an undeclared name throws at run time too (a cast around the type check)", async () => {
    const { envSpec } = await import("../../src/release/cli.js");
    const spec = envSpec("cf-rollback", ["CF_ACCOUNT_ID"]);
    expect(() => spec.require("ZZ_NEW_REQUIRED" as never)).toThrow(/not declared/);
  });
});
