/**
 * CLI-level tests for `runAuditLineageQualityCli` / `collectTargets` —
 * `paperpilot/scripts/audit_lineage_quality.py`'s `main()` (LIN-49, LIN-50).
 *
 * `auditLineageQuality.parity.test.ts` reconstructs the report loop
 * locally against the real `docs/` tree; it never calls
 * `runAuditLineageQualityCli` itself, so the CLI wrapper's own exit-code
 * mapping (and `collectTargets`'s target-selection policy) had no direct
 * coverage before this file.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectTargets } from "../../../src/lineage/quality/auditLineageQuality.js";
import {
  parseArgs,
  runAuditLineageQualityCli,
} from "../../../src/lineage/quality/auditLineageQualityCli.js";

function tmpDocsDir(): string {
  return mkdtempSync(join(tmpdir(), "audit-lq-cli-"));
}

describe("runAuditLineageQualityCli", () => {
  it("reports OK and exits 0 for a clean, well-formed lineage.json", () => {
    const docsDir = tmpDocsDir();
    mkdirSync(join(docsDir, "conf-a"), { recursive: true });
    writeFileSync(
      join(docsDir, "conf-a", "lineage.json"),
      JSON.stringify({
        root: "a",
        nodes: [{ id: "a", is_focus: true, title: "T", year: new Date().getUTCFullYear() }],
        edges: [],
        meta: {},
      }),
    );
    const rc = runAuditLineageQualityCli(parseArgs(["--docs-dir", docsDir], docsDir));
    expect(rc).toBe(0);
  });

  it("SKIPs an empty stub (nodes=[] edges=[]) and still exits 0", () => {
    const docsDir = tmpDocsDir();
    mkdirSync(join(docsDir, "conf-empty"), { recursive: true });
    writeFileSync(
      join(docsDir, "conf-empty", "lineage.json"),
      JSON.stringify({ nodes: [], edges: [] }),
    );
    const rc = runAuditLineageQualityCli(parseArgs(["--docs-dir", docsDir], docsDir));
    expect(rc).toBe(0);
  });

  it("FAILs and exits 1 on malformed JSON", () => {
    const docsDir = tmpDocsDir();
    mkdirSync(join(docsDir, "conf-bad"), { recursive: true });
    writeFileSync(join(docsDir, "conf-bad", "lineage.json"), "{not valid json");
    const rc = runAuditLineageQualityCli(parseArgs(["--docs-dir", docsDir], docsDir));
    expect(rc).toBe(1);
  });

  // LIN-50 (review fix): a `lineage.json` that EXISTS but cannot be read
  // for a reason other than "it doesn't exist" (here: the path is a
  // directory, not a file — EISDIR, not ENOENT) must still become a
  // target and FAIL the audit. The pre-fix `collectTargets` used a
  // `readFileSync` probe to decide membership, silently dropping any
  // such path from the target list — so a docs/ tree whose only
  // conference hit this case printed "no lineage.json found" and
  // exited 0 instead of exiting 1.
  it("LIN-50: an unreadable (not merely absent) lineage.json still FAILs the audit and exits 1, not 0", () => {
    const docsDir = tmpDocsDir();
    // A DIRECTORY named lineage.json: it exists, but reading it as a
    // file throws EISDIR, not ENOENT.
    mkdirSync(join(docsDir, "conf-unreadable", "lineage.json"), { recursive: true });

    expect(collectTargets(docsDir)).toEqual([join(docsDir, "conf-unreadable", "lineage.json")]);

    const rc = runAuditLineageQualityCli(parseArgs(["--docs-dir", docsDir], docsDir));
    expect(rc).toBe(1);
  });

  it("prints 'no lineage.json found' and exits 0 when the docs dir genuinely has nothing (true ENOENT case, contrast with LIN-50 above)", () => {
    const docsDir = tmpDocsDir(); // empty — no conferences at all
    const rc = runAuditLineageQualityCli(parseArgs(["--docs-dir", docsDir], docsDir));
    expect(rc).toBe(0);
  });
});
