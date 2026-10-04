/**
 * MEDIUM-14 (P4 review round 2): `runRealCli`'s top-level try/catch in
 * `collect/cli.ts` (`catch (e) { deps.logger.error(...); return 1; }`) was
 * never exercised with something OTHER than a config-loading failure — a
 * mutant changing that `return 1` to `return 0` would survive as long as
 * only `cli.spawn.test.ts`'s nonexistent-config case existed, because that
 * path also happens to be reachable other ways. This drives a throw from
 * inside the REAL runner construction path (`createRunner` -> `new
 * PipelineRunner(...)` -> `run()`) by replacing `PipelineRunner` itself
 * with a fake that throws, proving the catch's `return 1` specifically
 * (not just "some" exit code) for a runner failure, not just a config one.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/collect/runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/collect/runner.js")>();
  return {
    ...actual,
    PipelineRunner: class {
      llmProvider = null;
      async run(): Promise<never> {
        throw new Error("boom from the real runner construction path");
      }
    },
  };
});

const { runRealCli } = await import("../../src/collect/cli.js");

let dir: string;
let messages: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-real-cli-test-"));
  messages = [];
  vi.spyOn(console, "log").mockImplementation((msg: string) => {
    messages.push(String(msg));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function writeConfig(): string {
  const path = join(dir, "config.yaml");
  writeFileSync(path, "search:\n  keywords: [rag]\n  days_back: 7\nlogging:\n  level: ERROR\n");
  return path;
}

it("returns 1 (not 0) when the real runner construction path throws", async () => {
  const configPath = writeConfig();

  const rc = await runRealCli(["--config", configPath]);

  expect(rc).toBe(1);
  expect(messages.some((m) => /fatal/i.test(m) && m.includes("boom from the real runner"))).toBe(
    true,
  );
});
