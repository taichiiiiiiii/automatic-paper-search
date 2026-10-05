/**
 * Spawns the REAL `lineage/theme/slugCli.ts` entry through `tsx` — same
 * `execFileSync(tsx, …)` shape as `test/collect/cli.spawn.test.ts`.
 * p5-plan.md §2 A2: "one spawn test per CLI (`--help`, bad flag,
 * env-only free text). No network."
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/test/lineage/theme -> repo root (5 levels up).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_PATH = join(REPO_ROOT, "apps", "pipeline", "src", "lineage", "theme", "slugCli.ts");

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

describe("real tsx spawn of lineage/theme/slugCli.ts", () => {
  it("--help exits 0 and prints usage", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/usage: theme-slug/);
  }, 30_000);

  it("a bad argv token exits 2 (this CLI takes no flags at all)", () => {
    const { status, stderr } = runCli(["--theme", "Mixture of Experts"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/unrecognized/i);
  }, 30_000);

  it("free text comes only from THEME_INPUT (env), never argv: prints the derived slug and exits 0", () => {
    const { status, stdout } = runCli([], { ...process.env, THEME_INPUT: "Vision Transformer" });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("vision-transformer");
  }, 30_000);

  it("exits 1 with nothing on stdout when THEME_INPUT is unset", () => {
    const env = { ...process.env };
    delete env.THEME_INPUT;
    const { status, stdout } = runCli([], env);
    expect(status).toBe(1);
    expect(stdout).toBe("");
  }, 30_000);
});
