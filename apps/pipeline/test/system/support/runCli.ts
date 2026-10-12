/**
 * Runs a REAL pipeline CLI entry point inside a {@link Sandbox}: `node
 * --import tsx --import fixtureFetch.ts <sandbox>/apps/pipeline/src/<cli>`
 * with a scrubbed environment (no API keys from the developer's shell or
 * CI, so an LLM/OpenAlex key can never leak into a test run) and the
 * recorded-fixture HTTP layer installed.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FaultRule } from "./fixtureFetch.js";
import type { Sandbox } from "./sandbox.js";
import { SYSTEM_FIXTURES } from "./sandbox.js";

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  requests: RequestLog[];
}

export interface RequestLog {
  method: string;
  url: string;
  outcome: "fixture" | "fault" | "miss" | "record";
  status?: number | null;
  kind?: string;
}

export interface RunCliOptions {
  /** Fixture dirs relative to `test/system/fixtures`. */
  fixtures?: string[];
  faults?: FaultRule[];
  env?: Record<string, string>;
  timeoutMs?: number;
  /** One-off live recording into the first fixture dir (never in tests). */
  record?: boolean;
}

/** Corepack / CI switches the `pnpm` shim reads; nothing else leaks in. */
export function toolchainEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (k.startsWith("COREPACK_") || k === "CI")) out[k] = v;
  }
  return out;
}

export const PRELOAD = resolve(SYSTEM_FIXTURES, "..", "support", "fixtureFetch.ts");
let runSeq = 0;

export function runCli(
  sb: Sandbox,
  cli: string,
  args: string[],
  opts: RunCliOptions = {},
): Promise<CliRun> {
  runSeq += 1;
  const logFile = join(sb.root, "..", `fetch-log-${process.pid}-${runSeq}.jsonl`);
  const env: Record<string, string> = {
    // Only what the toolchain needs (pnpm via corepack for approveCli's
    // children); never API keys from the developer's shell or CI.
    ...toolchainEnv(),
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "C.UTF-8",
    TZ: "UTC",
    // NODE_OPTIONS (not argv) so CLIs that spawn other CLIs (approveCli ->
    // `pnpm exec tsx …`) carry the fixture layer into their children too.
    NODE_OPTIONS: `--max-old-space-size=1024 --import tsx --import ${pathToFileURL(PRELOAD).href}`,
    PAPERPILOT_FIXTURE_DIRS: (opts.fixtures ?? []).map((f) => join(SYSTEM_FIXTURES, f)).join(":"),
    PAPERPILOT_FIXTURE_LOG: logFile,
    PAPERPILOT_FIXTURE_FAULTS: JSON.stringify(opts.faults ?? []),
    ...(opts.record ? { PAPERPILOT_FIXTURE_RECORD: "1" } : { PAPERPILOT_FIXTURE_FAST_TIMERS: "1" }),
    ...(opts.env ?? {}),
  };
  const entry = join(sb.root, "apps/pipeline/src", cli);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: sb.root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const requests: RequestLog[] = existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as RequestLog)
        : [];
      resolvePromise({ code: code ?? (signal ? 137 : 1), stdout, stderr, requests });
    });
  });
}

/** Human-readable dump for assertion messages. */
export function describeRun(run: CliRun): string {
  const misses = run.requests
    .filter((r) => r.outcome === "miss")
    .map((r) => `${r.method} ${r.url}`);
  return [
    `exit=${run.code}`,
    `stdout:\n${run.stdout.slice(-3000)}`,
    `stderr:\n${run.stderr.slice(-4000)}`,
    `misses:\n${misses.slice(0, 30).join("\n")}`,
  ].join("\n");
}
