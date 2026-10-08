/**
 * `collect/config/env.ts` — P4 review round 2 MEDIUM-2: `process.env`
 * precedence over `.env` file values, `.env` parsing (inline comments,
 * `export` prefix), and the `find_dotenv`-style upward-search fallback
 * when no `.env` sits next to the config file.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultDotenvStartDir,
  defaultDotenvStopDir,
  findDotenvUpward,
  loadEnv,
  parseDotenv,
} from "../../../src/collect/config/env.js";

const KEY = "PAPERPILOT_GITHUB_TOKEN";

let dir: string;
let originalCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "env-test-"));
  originalCwd = process.cwd();
  delete process.env[KEY];
});

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env[KEY];
});

describe("parseDotenv", () => {
  it("strips a trailing inline comment from an unquoted value (whitespace then #)", () => {
    const vars = parseDotenv(`${KEY}=abc123 # a trailing comment\n`);
    expect(vars[KEY]).toBe("abc123");
  });

  it("does NOT treat a bare adjacent # (no preceding whitespace) as a comment", () => {
    const vars = parseDotenv("PAPERPILOT_SLACK_WEBHOOK_URL=http://hooks.example/a#fragment\n");
    expect(vars.PAPERPILOT_SLACK_WEBHOOK_URL).toBe("http://hooks.example/a#fragment");
  });

  it("strips a leading 'export ' prefix instead of folding it into the key", () => {
    const vars = parseDotenv(`export ${KEY}=exported_value\n`);
    expect(vars[KEY]).toBe("exported_value");
    expect(vars[`export ${KEY}`]).toBeUndefined();
  });

  it("a key that merely starts with the letters 'export' (no following prefix+space grammar) is unaffected", () => {
    const vars = parseDotenv("exported_flag=1\n");
    expect(vars.exported_flag).toBe("1");
  });

  it("strips a trailing inline comment after a QUOTED value, unlike the unquoted case requiring no leading space (P4 review round 3 LOW)", () => {
    const vars = parseDotenv(`${KEY}="v" # comment\n`);
    expect(vars[KEY]).toBe("v");
  });

  it("strips a quoted value's trailing comment even with NO space before the # (python-dotenv's _comment allows zero whitespace there)", () => {
    const vars = parseDotenv(`${KEY}="v"#comment\n`);
    expect(vars[KEY]).toBe("v");
  });

  it("a single-quoted value's trailing comment is stripped the same way", () => {
    const vars = parseDotenv(`${KEY}='v' # comment\n`);
    expect(vars[KEY]).toBe("v");
  });

  it("a quoted value with no trailing comment is still just unquoted", () => {
    const vars = parseDotenv(`${KEY}="plain-value"\n`);
    expect(vars[KEY]).toBe("plain-value");
  });
});

describe("findDotenvUpward: skips a non-regular-file .env (P4 review round 3 LOW)", () => {
  it("does not throw EISDIR when a `.env` DIRECTORY (e.g. a python -m venv .env) sits on the walk, and keeps walking to find the real file above it", () => {
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    // A `.env` DIRECTORY directly in the start dir (as `python -m venv .env`
    // would create) — must be skipped, not handed to readFileSync.
    mkdirSync(join(nested, ".env"));
    writeFileSync(join(dir, "a", ".env"), `${KEY}=from-above-the-venv-dir\n`);

    expect(() => findDotenvUpward(nested)).not.toThrow();
    expect(findDotenvUpward(nested)).toBe(join(dir, "a", ".env"));
  });

  it("loadEnv does not throw when the upward search's start dir has a `.env` directory in it", () => {
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(nested, ".env"));
    writeFileSync(join(dir, "a", ".env"), `${KEY}=from-above-the-venv-dir\n`);

    expect(() => loadEnv(null, nested)).not.toThrow();
    expect(loadEnv(null, nested).githubToken).toBe("from-above-the-venv-dir");
  });
});

describe("defaultDotenvStartDir (P4 review round 3 LOW)", () => {
  it("resolves to the layout's config dir (data/config), under the repo root containing pnpm-workspace.yaml", () => {
    const startDir = defaultDotenvStartDir();
    expect(startDir.endsWith(join("data", "config"))).toBe(true);
    expect(existsSync(join(startDir, ".env.example"))).toBe(true);
    const repoRoot = dirname(dirname(startDir));
    expect(existsSync(join(repoRoot, "pnpm-workspace.yaml"))).toBe(true);
    expect(defaultDotenvStopDir()).toBe(repoRoot);
  });

  it("findDotenvUpward with a stopDir never looks above it", () => {
    const outer = join(dir, "outer");
    const inner = join(outer, "repo", "data", "config");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, ".env"), "PAPERPILOT_GITHUB_TOKEN=outside\n");
    expect(findDotenvUpward(inner, join(outer, "repo"))).toBeNull();
    expect(findDotenvUpward(inner)).toBe(join(outer, ".env"));
  });

  it("loadEnv's default start dir (no startDir override) is no longer process.cwd() — a .env reachable only via cwd is NOT picked up", () => {
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, ".env"), `${KEY}=should-not-be-found-via-cwd\n`);
    process.chdir(nested);

    const env = loadEnv(null); // no startDir override — exercises the real default

    expect(env.githubToken).not.toBe("should-not-be-found-via-cwd");
  });
});

describe("loadEnv: process.env wins over a .env file value (load_dotenv override=False)", () => {
  it("prefers process.env when the same key is set in both", () => {
    process.env[KEY] = "from-process-env";
    writeFileSync(join(dir, ".env"), `${KEY}=from-dotenv-file\n`);
    const env = loadEnv(join(dir, ".env"));
    expect(env.githubToken).toBe("from-process-env");
  });

  it("falls back to the .env file value when process.env does not have the key", () => {
    writeFileSync(join(dir, ".env"), `${KEY}=from-dotenv-file\n`);
    const env = loadEnv(join(dir, ".env"));
    expect(env.githubToken).toBe("from-dotenv-file");
  });
});

describe("loadEnv: find_dotenv-style upward search when dotenvPath is null", () => {
  // The upward search's start dir is injected (the `startDir` param) rather
  // than relying on `process.chdir()` + `process.cwd()` — P4 review round 3
  // LOW: the port's real default start dir is now <repoRoot>/paperpilot/
  // utils (see `defaultDotenvStartDir`), not `process.cwd()`, so these
  // tests must stay independent of both the real repo's ancestor
  // directories and the process's current directory to exercise the same
  // upward-walk logic in isolation.
  it("walks up from the injected start dir and loads the first .env found in an ancestor directory", () => {
    const nested = join(dir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, ".env"), `${KEY}=from-upward-search\n`);

    const env = loadEnv(null, nested);

    expect(env.githubToken).toBe("from-upward-search");
  });

  it("process.env still wins over a .env file found via the upward search", () => {
    process.env[KEY] = "from-process-env";
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, ".env"), `${KEY}=from-upward-search\n`);

    const env = loadEnv(null, nested);

    expect(env.githubToken).toBe("from-process-env");
  });
});
