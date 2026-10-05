/**
 * CLI-level tests for `conference/scaffold/cli.ts` — p5-plan.md §2 A2:
 * "`--conference` from argv (validated slug). Display and lede come from
 * env `DISPLAY` / `LEDE` only." No CLI flags for `--display`/`--lede` at
 * all — passing them as argv must be an unrecognized-flag usage error.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseScaffoldCliArgs,
  runScaffoldCli,
  runScaffoldCliArgs,
} from "../../../src/conference/scaffold/cli.js";
import { CliUsageError } from "../../../src/shared/cli/argparse.js";

let copyDir: string;

beforeEach(() => {
  copyDir = mkdtempSync(join(tmpdir(), "scaffold-cli-"));
});
afterEach(() => {
  rmSync(copyDir, { recursive: true, force: true });
});

describe("parseScaffoldCliArgs", () => {
  it("requires --conference", () => {
    expect(() => parseScaffoldCliArgs([])).toThrow(CliUsageError);
  });

  it("parses --conference", () => {
    expect(parseScaffoldCliArgs(["--conference", "neurips-2026"])).toEqual({
      conference: "neurips-2026",
    });
  });

  it("rejects a --display flag (free text is env-only, never argv)", () => {
    expect(() =>
      parseScaffoldCliArgs(["--conference", "neurips-2026", "--display", "NeurIPS 2026"]),
    ).toThrow(CliUsageError);
  });

  it("rejects a --lede flag (free text is env-only, never argv)", () => {
    expect(() =>
      parseScaffoldCliArgs(["--conference", "neurips-2026", "--lede", "A lede."]),
    ).toThrow(CliUsageError);
  });
});

describe("runScaffoldCliArgs", () => {
  it("writes the per-slug file and exits 0 when DISPLAY/LEDE are set", () => {
    const result = runScaffoldCliArgs(
      { conference: "neurips-2026" },
      { DISPLAY: "NeurIPS 2026", LEDE: "A lede." },
      copyDir,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(copyDir, "neurips-2026.json"), "utf-8"))).toEqual({
      display: "NeurIPS 2026",
      lede: "A lede.",
    });
  });

  it("exits 1 when DISPLAY is unset", () => {
    const result = runScaffoldCliArgs({ conference: "neurips-2026" }, { LEDE: "ok" }, copyDir);
    expect(result.exitCode).toBe(1);
  });

  it("exits 1 when LEDE is unset", () => {
    const result = runScaffoldCliArgs({ conference: "neurips-2026" }, { DISPLAY: "ok" }, copyDir);
    expect(result.exitCode).toBe(1);
  });

  it("exits 1 for a reserved slug (e.g. 'lineage'), writing nothing", () => {
    const result = runScaffoldCliArgs(
      { conference: "lineage" },
      { DISPLAY: "X", LEDE: "Y" },
      copyDir,
    );
    expect(result.exitCode).toBe(1);
  });
});

describe("runScaffoldCli (argv + env -> exit code)", () => {
  it("--help exits 0", () => {
    expect(runScaffoldCli(["--help"], {}, "/unused")).toBe(0);
  });

  it("missing --conference exits 2", () => {
    expect(runScaffoldCli([], { DISPLAY: "X", LEDE: "Y" }, copyDir)).toBe(2);
  });

  it("a full real run exits 0", () => {
    expect(
      runScaffoldCli(
        ["--conference", "neurips-2026"],
        { DISPLAY: "NeurIPS 2026", LEDE: "A lede." },
        copyDir,
      ),
    ).toBe(0);
  });
});
