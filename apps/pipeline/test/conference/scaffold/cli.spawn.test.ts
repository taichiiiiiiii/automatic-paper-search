/**
 * Spawns the REAL `conference/scaffold/cli.ts` entry through `tsx`.
 * p5-plan.md §2 A2: "one spawn test per CLI (`--help`, bad flag,
 * env-only free text). No network."
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/test/conference/scaffold -> repo root (5 levels up).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_PATH = join(REPO_ROOT, "apps", "pipeline", "src", "conference", "scaffold", "cli.ts");

function runCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TSX, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
      env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? -1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
}

describe("real tsx spawn of conference/scaffold/cli.ts", () => {
  it("--help exits 0 and prints usage", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/usage: scaffold/);
  }, 30_000);

  it("a --display flag exits 2 (free text is env-only, never argv)", () => {
    const { status, stderr } = runCli([
      "--conference",
      "neurips-2026",
      "--display",
      "NeurIPS 2026",
    ]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/unrecognized/i);
  }, 30_000);

  it("DISPLAY/LEDE env vars (not argv) drive the write: missing --conference still exits 2 first", () => {
    const { status, stderr } = runCli([], {
      ...process.env,
      DISPLAY: "NeurIPS 2026",
      LEDE: "A lede.",
    });
    expect(status).toBe(2);
    expect(stderr).toMatch(/required/i);
  }, 30_000);

  it("missing DISPLAY exits 1 (configuration error, not a CLI usage error)", () => {
    const env = { ...process.env };
    delete env.DISPLAY;
    env.LEDE = "A lede.";
    const { status, stderr } = runCli(["--conference", "neurips-2026"], env);
    expect(status).toBe(1);
    expect(stderr).toMatch(/DISPLAY/);
  }, 30_000);
});
