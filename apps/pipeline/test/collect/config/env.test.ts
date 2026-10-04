/**
 * `collect/config/env.ts` — P4 review round 2 MEDIUM-2: `process.env`
 * precedence over `.env` file values, `.env` parsing (inline comments,
 * `export` prefix), and the `find_dotenv`-style upward-search fallback
 * when no `.env` sits next to the config file.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, parseDotenv } from "../../../src/collect/config/env.js";

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
  it("walks up from process.cwd() and loads the first .env found in an ancestor directory", () => {
    const nested = join(dir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, ".env"), `${KEY}=from-upward-search\n`);
    process.chdir(nested);

    const env = loadEnv(null);

    expect(env.githubToken).toBe("from-upward-search");
  });

  it("process.env still wins over a .env file found via the upward search", () => {
    process.env[KEY] = "from-process-env";
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, ".env"), `${KEY}=from-upward-search\n`);
    process.chdir(nested);

    const env = loadEnv(null);

    expect(env.githubToken).toBe("from-process-env");
  });
});
