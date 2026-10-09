import { describe, expect, it, vi } from "vitest";
import { exitCodeMatches, runCommand } from "../../src/parity/run-command.js";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("runCommand", () => {
  it("captures the exit code of a command that succeeds", async () => {
    const result = await runCommand(`node -e "process.exit(0)"`);
    expect(result.exitCode).toBe(0);
    expect(exitCodeMatches(result, 0)).toBe(true);
  });

  it("captures a non-zero exit code", async () => {
    const result = await runCommand(`node -e "process.exit(7)"`);
    expect(result.exitCode).toBe(7);
    expect(exitCodeMatches(result, 7)).toBe(true);
    expect(exitCodeMatches(result, 0)).toBe(false);
  });

  it("captures stdout", async () => {
    const result = await runCommand(`node -e "console.log('hi')"`);
    expect(result.stdout.trim()).toBe("hi");
  });
});
