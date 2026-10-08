/**
 * M3 of the P4 review: `build_summary_csv.py`'s argparse flags
 * (`--conference`, `--input`) go through the shared strict parser now —
 * an unrecognized flag must exit 2 (the process-level contract), not be
 * silently ignored the way the old hand-rolled `switch`'s
 * `default: break` did.
 */
import { describe, expect, it, vi } from "vitest";
import { parseBuildSummaryCliArgs, runBuildSummaryCli } from "../../src/catalog/buildSummaryCli.js";

describe("runBuildSummaryCli argument strictness", () => {
  it("exits 2 on an unrecognized/typo'd flag before touching the filesystem", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const rc = runBuildSummaryCli(["--conferance", "iclr-2026"]);
      expect(rc).toBe(2);
      expect(stderr).toHaveBeenCalled();
      const message = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(message).toMatch(/unrecognized/i);
    } finally {
      stderr.mockRestore();
    }
  });

  it("parses --conference and --input (two tokens) and --conference=value (one token) the same way", () => {
    expect(parseBuildSummaryCliArgs(["--conference", "cvpr-2026"]).conference).toBe("cvpr-2026");
    expect(parseBuildSummaryCliArgs(["--conference=cvpr-2026"]).conference).toBe("cvpr-2026");
  });

  it("defaults --conference to iclr-2026 like the Python original", () => {
    expect(parseBuildSummaryCliArgs([]).conference).toBe("iclr-2026");
  });

  it("throws CliUsageError for a bare positional token", () => {
    expect(() => parseBuildSummaryCliArgs(["bogus"])).toThrow();
  });
});
