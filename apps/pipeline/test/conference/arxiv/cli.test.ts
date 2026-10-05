/**
 * CLI-level tests for `conference/arxiv/cli.ts` — p5-plan.md §2 A2: "arXiv
 * conference collector: only `runCollectConferenceMain` exists, with no
 * `isMain` entry." Flags: `--conference --venue --query --max
 * --output-root` (default `layout.inputs`). `collect.ts`'s own
 * fetch/filter semantics are already covered by `collect.test.ts`; this
 * file covers only this wrapper's own argv handling and
 * `--output-root` default/forwarding.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultOutputRoot,
  parseArxivCliArgs,
  runArxivCli,
} from "../../../src/conference/arxiv/cli.js";
import type { ArxivTextResponse } from "../../../src/conference/shared/index.js";
import { CliUsageError } from "../../../src/shared/cli/argparse.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "arxiv-cli-"));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function atomFeed(entries: { id: string; comment?: string }[], total?: number): string {
  const body = entries
    .map(
      (e) =>
        `<entry><id>${e.id}</id><updated>2025-01-01T00:00:00Z</updated><published>2025-01-01T00:00:00Z</published>` +
        `<title>Paper</title><summary>abs</summary><author><name>Author</name></author>` +
        (e.comment ? `<arxiv:comment>${e.comment}</arxiv:comment>` : "") +
        `</entry>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">` +
    `<opensearch:totalResults>${total ?? entries.length}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex>` +
    body +
    `</feed>`
  );
}

function fakeFetchText(xml: string): (url: string) => Promise<ArxivTextResponse> {
  return async () => ({ status: 200, text: async () => xml });
}

describe("defaultOutputRoot", () => {
  it("is layout.inputs", () => {
    expect(defaultOutputRoot(repoRoot)).toBe(join(repoRoot, "paperpilot", "output"));
  });
});

describe("parseArxivCliArgs", () => {
  it("requires --conference/--venue/--query", () => {
    expect(() => parseArxivCliArgs([], repoRoot)).toThrow(CliUsageError);
  });

  // Each required flag is pinned INDEPENDENTLY (providing the other two)
  // so a mutant that drops just one flag's `required: true` cannot hide
  // behind the other two still being required -- caught empirically: the
  // combined "requires --conference/--venue/--query" case above did NOT
  // catch a mutant that dropped only --conference's `required: true`.
  it("requires --conference specifically, even with --venue/--query present", () => {
    expect(() => parseArxivCliArgs(["--venue", "CVPR", "--query", "q"], repoRoot)).toThrow(
      /--conference/,
    );
  });

  it("requires --venue specifically, even with --conference/--query present", () => {
    expect(() => parseArxivCliArgs(["--conference", "c", "--query", "q"], repoRoot)).toThrow(
      /--venue/,
    );
  });

  it("requires --query specifically, even with --conference/--venue present", () => {
    expect(() => parseArxivCliArgs(["--conference", "c", "--venue", "CVPR"], repoRoot)).toThrow(
      /--query/,
    );
  });

  it("defaults --max to 800 and --output-root to layout.inputs", () => {
    const args = parseArxivCliArgs(
      ["--conference", "cvpr-2026", "--venue", "CVPR", "--query", 'co:"CVPR 2026"'],
      repoRoot,
    );
    expect(args.max).toBe(800);
    expect(args.outputRoot).toBe(defaultOutputRoot(repoRoot));
    expect(args.clearOral).toBe(false);
  });

  it("accepts an explicit --output-root override", () => {
    const args = parseArxivCliArgs(
      [
        "--conference",
        "cvpr-2026",
        "--venue",
        "CVPR",
        "--query",
        "q",
        "--output-root",
        "/tmp/custom-root",
      ],
      repoRoot,
    );
    expect(args.outputRoot).toBe("/tmp/custom-root");
  });

  it("a non-integer --max throws CliUsageError", () => {
    expect(() =>
      parseArxivCliArgs(
        ["--conference", "c", "--venue", "V", "--query", "q", "--max", "abc"],
        repoRoot,
      ),
    ).toThrow(CliUsageError);
  });

  it("an unrecognized flag throws CliUsageError", () => {
    expect(() =>
      parseArxivCliArgs(["--conference", "c", "--venue", "V", "--query", "q", "--bogus"], repoRoot),
    ).toThrow(CliUsageError);
  });
});

describe("runArxivCli (forwards to runCollectConferenceMain with the injected fetchText + outputRoot)", () => {
  it("writes a CSV under --output-root and returns 0 for a genuine match", async () => {
    const outputRoot = join(repoRoot, "out");
    const args = parseArxivCliArgs(
      [
        "--conference",
        "testconf",
        "--venue",
        "CVPR",
        "--query",
        'co:"CVPR 2026"',
        "--output-root",
        outputRoot,
      ],
      repoRoot,
    );
    // "CVPR" is a real VenueSignal-recognized token (collect/signals/venue.ts
    // TIER_2) — VenueSignal.classify only matches a known venue, so an
    // invented token like "TESTCONF" would never produce a genuine match
    // regardless of the comment text.
    const xml = atomFeed([
      { id: "http://arxiv.org/abs/2601.00001", comment: "Accepted to CVPR 2026" },
    ]);
    const code = await runArxivCli(args, fakeFetchText(xml));
    expect(code).toBe(0);
    expect(existsSync(join(outputRoot, "testconf"))).toBe(true);
    const files = readdirSync(join(outputRoot, "testconf"));
    expect(files.some((f) => f.startsWith("papers_") && f.endsWith(".csv"))).toBe(true);
  });

  it("returns 1 (writes nothing) when zero papers matched", async () => {
    const outputRoot = join(repoRoot, "out-empty");
    const args = parseArxivCliArgs(
      ["--conference", "testconf", "--venue", "CVPR", "--query", "q", "--output-root", outputRoot],
      repoRoot,
    );
    const xml = atomFeed([]);
    const code = await runArxivCli(args, fakeFetchText(xml));
    expect(code).toBe(1);
    expect(existsSync(outputRoot)).toBe(false);
  });
});
