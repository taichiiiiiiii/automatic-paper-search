/**
 * Promote a validated generated-data candidate from a fresh `develop` tip —
 * TS port of `.github/scripts/promote-generated.sh`.
 *
 * Implements PUB-01..15 of `docs/migration/safety-contracts.md`: candidate
 * unpack + allowlist validation, the CAS (compare-and-swap) check against a
 * fresh `origin/develop`, a bounded force-push-free retry loop, and the
 * refresh + validate hooks that run against the promoted tree before it is
 * staged.
 *
 * `refreshSharedOutputs` / `validatePromotedTree` are injected so this
 * library does not hard-code a dependency on `apps/pipeline/src/catalog/`
 * (owned by a concurrent change) or shell out to Python. The default
 * implementations here wire in the two derived builders this change does
 * own (`./derived/searchIndex.ts`, `./derived/identityLite.ts`); the other
 * shared-output refreshers the shell original runs for a `conference`
 * promotion (`build_pages.py`, `build_lineage_quality.py`,
 * `sync_asset_versions.py`, `build_sitemap.py`) and for a `themes`
 * promotion (`generate_themes_manifest.py`, `compute_theme_quality.py`,
 * etc.) are **not wired** here — the default hook throws a clear
 * "not wired until apps/pipeline/src/catalog lands" error for any kind
 * other than `test-only`, which is the intentional gap this change
 * reports. A caller that already has those builders (or the real Python
 * CLIs, shelled out) can pass its own `refreshSharedOutputs` /
 * `validatePromotedTree` to run them for real.
 */

import { cpSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkCandidateFiles } from "./candidateWalk.js";
import { buildIdentityLite, loadConferenceNames } from "./derived/identityLite.js";
import { writeSearchIndexes } from "./derived/searchIndex.js";
import { type GitAdapter, git, gitOk } from "./git/gitAdapter.js";
import { isDirPermitted, isFilePermitted, validateAllowlistEntry } from "./paths.js";

export type PromotionKind = "themes" | "conference" | "test-only";

const AS_OF_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const BASE_SHA_RE = /^[0-9a-f]{40}$/;

const SHARED_PATHS: Record<PromotionKind, string[]> = {
  themes: [
    "docs/themes/themes-manifest.json",
    "docs/themes/_quality.json",
    "docs/lineage-quality-v1.json",
    "docs/assets/versions.json",
    "docs/sitemap.xml",
  ],
  conference: [
    "docs/conferences.json",
    "docs/identity-aliases-v1.json",
    "docs/lineage-quality-v1.json",
    "docs/paper-details-v1",
    "docs/search-index.json",
    "docs/search-index-v2.json",
    "docs/search-paper-ids-v1",
    "docs/assets/versions.json",
    "docs/sitemap.xml",
    "paperpilot/data/identity-coverage-v1.json",
  ],
  "test-only": [],
};

export interface RefreshContext {
  tree: string;
  kind: PromotionKind;
  asOf: string;
}

export interface ValidateContext {
  tree: string;
  kind: PromotionKind;
}

export type RefreshSharedOutputsFn = (ctx: RefreshContext) => void | Promise<void>;
export type ValidatePromotedTreeFn = (ctx: ValidateContext) => void | Promise<void>;

export class PromotionError extends Error {}

/**
 * Default `refreshSharedOutputs`: wires only the two derived builders this
 * change owns (search index + identity-lite), and only for the
 * `conference` kind (the `themes` kind's shared-output refreshers —
 * `generate_themes_manifest`, `compute_theme_quality`, `build_lineage_quality`
 * — have no TS port yet). `test-only` is a no-op, matching the shell's
 * `test-only) ;;` branch.
 */
export const defaultRefreshSharedOutputs: RefreshSharedOutputsFn = ({ tree, kind, asOf }) => {
  if (kind === "test-only") return;
  if (kind !== "conference") {
    throw new PromotionError(
      `refreshSharedOutputs for kind "${kind}" is not wired until apps/pipeline/src/catalog lands ` +
        "(build_pages / themes-manifest / lineage-quality / sync_asset_versions / build_sitemap have no TS port in this change)",
    );
  }
  const docsRoot = join(tree, "docs");
  // Mirrors the shell's `conference)` branch order: build_pages.py (not
  // wired here — see the error above if this is ever reached without a
  // custom hook), build_identity_lite, build_search_index. identity-lite
  // and search-index are the two builders this change ports.
  const conferenceNames = loadConferenceNames(docsRoot);
  buildIdentityLite({
    docsRoot,
    conferenceNames,
    asOf,
    coveragePath: join(tree, "paperpilot", "data", "identity-coverage-v1.json"),
  });
  writeSearchIndexes(docsRoot);
};

/**
 * Default `validatePromotedTree`: a no-op for `test-only` (matching the
 * shell's early `return` for that kind); throws for every other kind,
 * since lint/pytest/audit equivalents (Biome + Vitest + Node audits) have
 * no TS port in this change.
 */
export const defaultValidatePromotedTree: ValidatePromotedTreeFn = ({ kind }) => {
  if (kind === "test-only") return;
  throw new PromotionError(
    `validatePromotedTree for kind "${kind}" is not wired until apps/pipeline/src/catalog lands ` +
      "(no TS port of ruff/pytest/audit_theme_seeds/audit_lineage_quality equivalents in this change)",
  );
};

export interface PromoteOptions {
  kind: PromotionKind;
  /** Directory holding the unpacked candidate (equivalent to the shell's `candidate-dir` argument). */
  candidateDir: string;
  commitMessage: string;
  allowedPaths: string[];
  git: GitAdapter;
  /** The checkout whose `origin` remote is promoted into (equivalent to running the shell script with this as `cwd`). */
  cwd: string;
  promoteAsOf?: string;
  promoteBaseSha?: string;
  promoteMaxAttempts?: number;
  promoteNoSleep?: boolean;
  /** Required (and checked) for `kind: "test-only"`, mirroring `PAPERPILOT_PROMOTION_TEST_MODE=1`. */
  promotionTestMode?: boolean;
  refreshSharedOutputs?: RefreshSharedOutputsFn;
  validatePromotedTree?: ValidatePromotedTreeFn;
  sleep?: (ms: number) => Promise<void>;
  tmpDir?: string;
}

export interface PromoteResult {
  sourceSha: string;
  changed: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateUsage(options: PromoteOptions): { allowedParts: string[][] } {
  if (options.allowedPaths.length === 0) {
    throw new PromotionError("usage: at least one allowed path is required");
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(options.candidateDir);
  } catch {
    throw new PromotionError(`candidate directory does not exist: ${options.candidateDir}`);
  }
  if (!stat.isDirectory()) {
    throw new PromotionError(`candidate directory does not exist: ${options.candidateDir}`);
  }
  const allowedParts = options.allowedPaths.map((raw) => validateAllowlistEntry(raw));
  return { allowedParts };
}

function validateKindAndBaseSha(options: PromoteOptions): void {
  if (options.kind === "themes" || options.kind === "conference") {
    if (!options.promoteBaseSha || !BASE_SHA_RE.test(options.promoteBaseSha)) {
      throw new PromotionError("PROMOTE_BASE_SHA must identify the 40-character generation base");
    }
  } else if (options.kind === "test-only") {
    if (!options.promotionTestMode) {
      throw new PromotionError("test-only mode is disabled");
    }
    const originUrl = git(options.git, options.cwd, ["remote", "get-url", "origin"]);
    if (!(originUrl.startsWith("/") || originUrl.startsWith("file://"))) {
      throw new PromotionError("test-only mode requires a local filesystem remote");
    }
  } else {
    throw new PromotionError(`unknown promotion kind: ${options.kind as string}`);
  }
}

function assertCandidateAllowlisted(candidateDir: string, allowedParts: string[][]): void {
  const realCandidateDir = realpathSync(candidateDir);
  const { foundFile } = walkCandidateFiles(realCandidateDir, (relPosixParts, isDir) => {
    const permitted = isDir
      ? isDirPermitted(relPosixParts, allowedParts)
      : isFilePermitted(relPosixParts, allowedParts);
    if (!permitted) {
      throw new PromotionError(`candidate path is outside allowlist: ${relPosixParts.join("/")}`);
    }
  });
  if (!foundFile) {
    throw new PromotionError("candidate contains no files");
  }
}

/** Promote `options.candidateDir` into `origin/develop` with a bounded CAS retry loop. */
export async function promote(options: PromoteOptions): Promise<PromoteResult> {
  const { allowedParts } = validateUsage(options);
  validateKindAndBaseSha(options);

  const asOf = options.promoteAsOf ?? `${new Date().toISOString().slice(0, 19)}Z`;
  if (!AS_OF_RE.test(asOf)) {
    throw new PromotionError("PROMOTE_AS_OF must be a UTC timestamp such as 2026-08-30T00:00:00Z");
  }

  const candidateDir = realpathSync(options.candidateDir);
  assertCandidateAllowlisted(candidateDir, allowedParts);

  const maxAttempts = options.promoteMaxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new PromotionError("PROMOTE_MAX_ATTEMPTS must be positive");
  }

  const refreshSharedOutputs = options.refreshSharedOutputs ?? defaultRefreshSharedOutputs;
  const validatePromotedTree = options.validatePromotedTree ?? defaultValidatePromotedTree;
  const sleep = options.sleep ?? defaultSleep;
  const base = options.tmpDir ?? tmpdir();
  const sharedPaths = SHARED_PATHS[options.kind];
  const adapter = options.git;

  let attemptDir: string | undefined;
  const cleanupAttempt = (): void => {
    if (attemptDir) {
      try {
        rmSync(attemptDir, { recursive: true, force: true });
      } catch {
        // best-effort, matching the shell's own cleanup
      }
      gitOk(adapter, options.cwd, ["worktree", "prune"]);
      attemptDir = undefined;
    }
  };

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      cleanupAttempt();

      git(adapter, options.cwd, ["fetch", "--no-tags", "origin", "develop"]);
      const remoteSha = git(adapter, options.cwd, ["rev-parse", "refs/remotes/origin/develop"]);

      if (options.promoteBaseSha) {
        if (
          !gitOk(adapter, options.cwd, ["cat-file", "-e", `${options.promoteBaseSha}^{commit}`])
        ) {
          throw new PromotionError(`generation base is not available: ${options.promoteBaseSha}`);
        }
        if (
          !gitOk(adapter, options.cwd, [
            "merge-base",
            "--is-ancestor",
            options.promoteBaseSha,
            remoteSha,
          ])
        ) {
          throw new PromotionError("generation base is not an ancestor of the current develop tip");
        }
        if (
          !gitOk(adapter, options.cwd, [
            "diff",
            "--quiet",
            options.promoteBaseSha,
            remoteSha,
            "--",
            ...options.allowedPaths,
          ])
        ) {
          throw new PromotionError(
            "candidate paths changed on develop after generation; regenerate instead of overwriting",
          );
        }
      }

      attemptDir = mkdtempSync(join(base, "paperpilot-promote."));
      const tree = join(attemptDir, "tree");
      git(adapter, options.cwd, ["worktree", "add", "--detach", tree, remoteSha]);
      cpSync(candidateDir, tree, { recursive: true, dereference: false, preserveTimestamps: true });

      await refreshSharedOutputs({ tree, kind: options.kind, asOf });
      await validatePromotedTree({ tree, kind: options.kind });

      git(adapter, tree, ["config", "user.email", "actions@users.noreply.github.com"]);
      git(adapter, tree, ["config", "user.name", "github-actions[bot]"]);
      git(adapter, tree, ["add", "-A", "--", ...options.allowedPaths]);
      if (sharedPaths.length > 0) {
        git(adapter, tree, ["add", "-A", "--", ...sharedPaths]);
      }
      if (!gitOk(adapter, tree, ["diff", "--quiet"])) {
        throw new PromotionError(
          "refresh produced tracked changes outside the promotion allowlist",
        );
      }
      const untracked = git(adapter, tree, ["ls-files", "--others", "--exclude-standard"]);
      if (untracked.trim() !== "") {
        throw new PromotionError(
          "refresh produced untracked files outside the promotion allowlist",
        );
      }

      if (gitOk(adapter, tree, ["diff", "--cached", "--quiet"])) {
        return { sourceSha: remoteSha, changed: false };
      }

      git(adapter, tree, ["commit", "-m", options.commitMessage]);
      const promotedSha = git(adapter, tree, ["rev-parse", "HEAD"]);
      if (gitOk(adapter, tree, ["push", "origin", "HEAD:develop"])) {
        return { sourceSha: promotedSha, changed: true };
      }

      if (attempt < maxAttempts && !options.promoteNoSleep) {
        await sleep(attempt * 2000);
      }
    }
  } finally {
    cleanupAttempt();
  }

  throw new PromotionError(`promotion failed after ${maxAttempts} compare-and-swap attempts`);
}
