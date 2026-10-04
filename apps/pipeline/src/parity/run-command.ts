import { spawn } from "node:child_process";

export interface RunCommandOptions {
  cwd?: string;
  /** Run through the shell so a single command string with args/pipes works. Default: true. */
  shell?: boolean;
}

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `command` to completion and captures its exit code + output, for failure-path checks. */
export function runCommand(
  command: string,
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: options.cwd, shell: options.shell ?? true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ exitCode: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

export function exitCodeMatches(result: RunCommandResult, expected: number): boolean {
  return result.exitCode === expected;
}
