#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { compareTreesByteExact } from "./byte-compare.js";
import { compareTrees } from "./compare-trees.js";
import { formatSummary } from "./report.js";
import { loadRules } from "./rules.js";
import { runCommand } from "./run-command.js";
import type { ParityReport } from "./types.js";

const USAGE = `Usage:
  parity --expected <dir> --actual <dir> [--json-rules <rules.json>] [--report <out.json>]
  parity --expect-unchanged <dir> --snapshot <dir> [--run "<command>"] [--expect-exit-code <n>] [--report <out.json>]`;

type ArgValue = string | boolean;
type Args = Record<string, ArgValue>;

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function asString(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export async function runCli(
  argv: readonly string[],
): Promise<{ exitCode: number; report?: ParityReport }> {
  const args = parseArgs(argv);

  const expectUnchangedDir = asString(args, "expect-unchanged");
  const snapshotDir = asString(args, "snapshot");
  const expectedDir = asString(args, "expected");
  const actualDir = asString(args, "actual");

  let report: ParityReport;

  if (expectUnchangedDir !== undefined && snapshotDir !== undefined) {
    // Run the command FIRST, then compare: the point of this mode is to catch a
    // command that (wrongly) wrote into `dir`, so the byte comparison must observe
    // whatever the command left behind, not a snapshot taken before it ran.
    const command = asString(args, "run");
    let commandResult: { exitCode: number } | undefined;
    if (command !== undefined) {
      commandResult = await runCommand(command, { cwd: process.cwd() });
    }

    report = await compareTreesByteExact({ dir: expectUnchangedDir, snapshot: snapshotDir });

    if (command !== undefined && commandResult !== undefined) {
      report.command = command;
      report.commandExitCode = commandResult.exitCode;
      const expectExitCode = asString(args, "expect-exit-code");
      if (expectExitCode !== undefined) {
        const expected = Number(expectExitCode);
        report.expectedExitCode = expected;
        report.commandExitOk = commandResult.exitCode === expected;
        if (!report.commandExitOk) report.equal = false;
      }
    }
  } else if (expectedDir !== undefined && actualDir !== undefined) {
    const rulesFile = asString(args, "json-rules");
    const rules = await loadRules(rulesFile);
    report = await compareTrees({
      expectedRoot: expectedDir,
      actualRoot: actualDir,
      rules,
      rulesFile,
    });
  } else {
    console.error(USAGE);
    return { exitCode: 2 };
  }

  console.log(formatSummary(report));

  const reportPath = asString(args, "report");
  if (reportPath !== undefined) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return { exitCode: report.equal ? 0 : 1, report };
}

const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
})();

if (isMainModule) {
  runCli(process.argv.slice(2)).then(
    ({ exitCode }) => {
      process.exitCode = exitCode;
    },
    (err) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exitCode = 2;
    },
  );
}
