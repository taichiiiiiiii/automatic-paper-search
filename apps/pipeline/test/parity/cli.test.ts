import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/pipeline/test/parity -> apps/pipeline/test -> apps/pipeline -> apps -> <repo root>
const repoRoot = path.resolve(here, "../../../..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cliPath = path.join(repoRoot, "apps", "pipeline", "src", "parity", "cli.ts");
const fixturesRoot = path.join(here, "fixtures");

/**
 * Spawns the CLI with an argv array (shell: false), so arguments — including a --run
 * value that itself contains quotes — reach the process verbatim with no shell-quoting
 * to get wrong. The CLI's own `--run` command string is only ever handed to a shell
 * inside run-command.ts, once, so there is no double-escaping here.
 */
function runCli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliPath, ...args], { cwd: repoRoot });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout });
    });
  });
}

describe("parity CLI", () => {
  it("exits 0 and prints PASS for equal trees", async () => {
    const { exitCode, stdout } = await runCli([
      "--expected",
      path.join(fixturesRoot, "equal", "expected"),
      "--actual",
      path.join(fixturesRoot, "equal", "actual"),
    ]);
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  });

  it("exits 1 and prints FAIL for a value diff", async () => {
    const { exitCode, stdout } = await runCli([
      "--expected",
      path.join(fixturesRoot, "value-diff", "expected"),
      "--actual",
      path.join(fixturesRoot, "value-diff", "actual"),
    ]);
    expect(stdout).toContain("FAIL");
    expect(exitCode).toBe(1);
  });

  it("writes a machine-readable JSON report with --report", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "parity-cli-report-"));
    try {
      const reportPath = path.join(tmp, "report.json");
      await runCli([
        "--expected",
        path.join(fixturesRoot, "equal", "expected"),
        "--actual",
        path.join(fixturesRoot, "equal", "actual"),
        "--report",
        reportPath,
      ]);
      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(report.mode).toBe("compare-trees");
      expect(report.equal).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("supports --json-rules to ignore a pointer, and reports it", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "parity-cli-rules-"));
    try {
      const rulesPath = path.join(tmp, "rules.json");
      await fs.writeFile(
        rulesPath,
        JSON.stringify({
          ignore: [{ glob: "manifest.json", pointers: ["/generated_at", "/items/*/generated_at"] }],
        }),
      );
      const { exitCode, stdout } = await runCli([
        "--expected",
        path.join(fixturesRoot, "ignored-pointer", "expected"),
        "--actual",
        path.join(fixturesRoot, "ignored-pointer", "actual"),
        "--json-rules",
        rulesPath,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("PASS");
      expect(stdout).toContain("ignored pointers");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("supports --expect-unchanged/--snapshot and exits 0 when identical", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "parity-cli-unchanged-"));
    try {
      const dir = path.join(tmp, "dir");
      const snapshot = path.join(tmp, "snapshot");
      await fs.mkdir(dir, { recursive: true });
      await fs.mkdir(snapshot, { recursive: true });
      await fs.writeFile(path.join(dir, "f.txt"), "unchanged\n");
      await fs.writeFile(path.join(snapshot, "f.txt"), "unchanged\n");

      const { exitCode, stdout } = await runCli([
        "--expect-unchanged",
        dir,
        "--snapshot",
        snapshot,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("PASS");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("supports --run + --expect-exit-code and fails the overall check on a mismatched exit code", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "parity-cli-run-"));
    try {
      const dir = path.join(tmp, "dir");
      const snapshot = path.join(tmp, "snapshot");
      await fs.mkdir(dir, { recursive: true });
      await fs.mkdir(snapshot, { recursive: true });
      await fs.writeFile(path.join(dir, "f.txt"), "unchanged\n");
      await fs.writeFile(path.join(snapshot, "f.txt"), "unchanged\n");

      const ok = await runCli([
        "--expect-unchanged",
        dir,
        "--snapshot",
        snapshot,
        "--run",
        'node -e "process.exit(2)"',
        "--expect-exit-code",
        "2",
      ]);
      expect(ok.exitCode).toBe(0);

      const mismatched = await runCli([
        "--expect-unchanged",
        dir,
        "--snapshot",
        snapshot,
        "--run",
        'node -e "process.exit(2)"',
        "--expect-exit-code",
        "0",
      ]);
      expect(mismatched.exitCode).toBe(1);
      expect(mismatched.stdout).toContain("FAIL");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("runs --run BEFORE comparing, so a command that writes into dir is caught as a leak", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "parity-cli-leak-"));
    try {
      const dir = path.join(tmp, "dir");
      const snapshot = path.join(tmp, "snapshot");
      await fs.mkdir(dir, { recursive: true });
      await fs.mkdir(snapshot, { recursive: true });
      await fs.writeFile(path.join(dir, "f.txt"), "unchanged\n");
      await fs.writeFile(path.join(snapshot, "f.txt"), "unchanged\n");

      const leakPath = path.join(dir, "leak.json");
      const reportPath = path.join(tmp, "report.json");
      const { exitCode, stdout } = await runCli([
        "--expect-unchanged",
        dir,
        "--snapshot",
        snapshot,
        "--run",
        `node -e ${JSON.stringify(`require("fs").writeFileSync(${JSON.stringify(leakPath)}, "{}")`)}`,
        "--report",
        reportPath,
      ]);

      expect(exitCode).toBe(1);
      expect(stdout).toContain("FAIL");
      expect(stdout).toContain("leak.json");
      expect(await fs.readFile(leakPath, "utf8")).toBe("{}");

      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(report.equal).toBe(false);
      expect(report.extraFiles).toEqual(["leak.json"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("exits 2 with usage when required flags are missing", async () => {
    const { exitCode } = await runCli([]);
    expect(exitCode).toBe(2);
  });
});
