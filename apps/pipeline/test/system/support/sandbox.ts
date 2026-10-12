/**
 * A throw-away copy of the minimal repo layout the pipeline CLIs need.
 *
 * Every CLI resolves its repo root from its own file location
 * (`resolve(HERE, "..", …)`), so running the REAL entry points against a
 * temp data tree means running a COPY of the sources that lives inside
 * that temp tree: `apps/pipeline/src`, `packages/core/src`, `schemas/`,
 * with `node_modules` symlinked back to this checkout's install. The
 * sandbox is a git repo with a bare `origin` (branch `develop`), so
 * `release/promote.ts` can run its compare-and-swap push for real.
 *
 * Nothing here ever writes under the real checkout's `data/`.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/pipeline/test/system/support -> repo root. */
export const REAL_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
export const SYSTEM_FIXTURES = resolve(HERE, "..", "fixtures");

export interface Sandbox {
  root: string;
  origin: string;
  /** Absolute path inside the sandbox. */
  path: (...rel: string[]) => string;
  readJson: <T = unknown>(...rel: string[]) => T;
  writeJson: (rel: string, value: unknown) => void;
  git: (...args: string[]) => string;
  cleanup: () => void;
}

function linkDeps(realPkgDir: string, sandboxPkgDir: string, local: Record<string, string>): void {
  const realNm = join(realPkgDir, "node_modules");
  const nm = join(sandboxPkgDir, "node_modules");
  mkdirSync(nm, { recursive: true });
  for (const name of readdirSync(realNm)) {
    if (name === ".bin" || name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      mkdirSync(join(nm, name), { recursive: true });
      for (const sub of readdirSync(join(realNm, name))) {
        const full = `${name}/${sub}`;
        const target = local[full] ?? realpathSync(join(realNm, name, sub));
        symlinkSync(target, join(nm, name, sub));
      }
    } else {
      symlinkSync(local[name] ?? realpathSync(join(realNm, name)), join(nm, name));
    }
  }
}

export interface SandboxOptions {
  /** Repo-relative files/dirs copied from the REAL checkout's data tree. */
  copyData?: string[];
  /** Fixture subtrees: `[fixtureRelPath, sandboxRelPath]`. */
  copyFixtures?: [string, string][];
  /** Extra JSON files written before the base commit (`rel -> value`). */
  files?: Record<string, unknown>;
}

export function createSandbox(options: SandboxOptions = {}): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pp-system-")));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  mkdirSync(repo);

  for (const rel of [
    "apps/pipeline/src",
    "apps/pipeline/package.json",
    "apps/pipeline/tsconfig.json",
    "packages/core/src",
    "packages/core/package.json",
    "packages/core/tsconfig.json",
    "schemas",
    "package.json",
    "tsconfig.base.json",
  ]) {
    cpSync(join(REAL_ROOT, rel), join(repo, rel), { recursive: true });
  }
  symlinkSync(join(REAL_ROOT, "node_modules"), join(repo, "node_modules"));
  linkDeps(join(REAL_ROOT, "apps/pipeline"), join(repo, "apps/pipeline"), {
    "@paperpilot/core": "../../../../packages/core",
  });
  linkDeps(join(REAL_ROOT, "packages/core"), join(repo, "packages/core"), {});

  mkdirSync(join(repo, "data/published"), { recursive: true });
  mkdirSync(join(repo, "data/state/lineage-cache"), { recursive: true });
  mkdirSync(join(repo, "data/inputs"), { recursive: true });
  cpSync(join(REAL_ROOT, "data/config"), join(repo, "data/config"), { recursive: true });
  for (const rel of options.copyData ?? []) {
    cpSync(join(REAL_ROOT, rel), join(repo, rel), { recursive: true });
  }
  for (const [from, to] of options.copyFixtures ?? []) {
    cpSync(join(SYSTEM_FIXTURES, from), join(repo, to), { recursive: true });
  }

  for (const [rel, value] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), `${JSON.stringify(value, null, 2)}\n`);
  }

  const git = (...args: string[]): string => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "develop");
  git("config", "user.email", "system-test@example.invalid");
  git("config", "user.name", "system-test");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "sandbox base");
  const r = spawnSync("git", ["init", "-q", "--bare", "-b", "develop", origin], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "develop");
  git("fetch", "-q", "origin");

  const path = (...rel: string[]): string => join(repo, ...rel);
  return {
    root: repo,
    origin,
    path,
    readJson: <T>(...rel: string[]) => JSON.parse(readFileSync(path(...rel), "utf8")) as T,
    writeJson: (rel, value) => {
      mkdirSync(dirname(path(rel)), { recursive: true });
      writeFileSync(path(rel), `${JSON.stringify(value, null, 2)}\n`);
    },
    git,
    cleanup: () => {
      if (existsSync(root))
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
