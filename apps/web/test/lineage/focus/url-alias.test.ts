/**
 * Direct unit coverage for lib/lineage/v2/url-alias.ts -- P2 review
 * LOWs:
 *   - `validHttpUrl` was previously only exercised indirectly (via
 *     artifact.ts's evidence validation rejecting a syntactically
 *     malformed `https://[` URL in test/lineage/focus/v2-core.test.ts),
 *     so the actual http(s)-only scheme restriction itself (as opposed
 *     to "URL does not parse at all") had no test. `safeEvidenceLink`
 *     (lib/lineage/v2/layout.ts, the render-time analogue of the same
 *     check) is covered in test/lineage/focus/layout.test.ts.
 *   - `safeJsonPath`/`validPilotPath` (SCR-47): the only existing
 *     traversal test (v2-core.test.ts's "percent/traversal paths are
 *     rejected") only exercises a PERCENT-ENCODED `%2e%2e` segment,
 *     which `validPilotPath`'s own `%` ban alone would already reject
 *     -- `safeJsonPath`'s separate defenses (literal `..` segments,
 *     absolute paths, backslashes, a Windows drive letter, control
 *     characters, a `.git` segment) were never exercised directly.
 */
import { describe, expect, it } from "vitest";
import { safeJsonPath, validHttpUrl, validPilotPath } from "../../../lib/lineage/v2/url-alias";

describe("validHttpUrl", () => {
  it("accepts http and https URLs with a host", () => {
    expect(validHttpUrl("https://example.com/paper")).toBe(true);
    expect(validHttpUrl("http://example.com/paper")).toBe(true);
  });

  it("rejects non-http(s) schemes, even when the URL parses fine", () => {
    expect(validHttpUrl("javascript:alert(1)")).toBe(false);
    expect(validHttpUrl("ftp://example.com/paper")).toBe(false);
    expect(validHttpUrl("file:///etc/passwd")).toBe(false);
    expect(validHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects a syntactically malformed URL instead of throwing", () => {
    expect(validHttpUrl("https://[")).toBe(false);
    expect(validHttpUrl("not a url")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(validHttpUrl(null)).toBe(false);
    expect(validHttpUrl(undefined)).toBe(false);
    expect(validHttpUrl(42)).toBe(false);
    expect(validHttpUrl({})).toBe(false);
  });
});

describe("safeJsonPath", () => {
  it("accepts a well-formed relative .json path", () => {
    expect(safeJsonPath("lineage-pilots/iclr-2026/aaaa/artifacts/bbbb.json")).toBe(true);
  });

  it("rejects a literal .. traversal segment (not percent-encoded)", () => {
    expect(safeJsonPath("lineage-pilots/../../etc/passwd.json")).toBe(false);
    expect(safeJsonPath("../outside.json")).toBe(false);
  });

  it("rejects a bare . segment", () => {
    expect(safeJsonPath("lineage-pilots/./x.json")).toBe(false);
  });

  it("rejects an absolute path", () => {
    expect(safeJsonPath("/etc/passwd.json")).toBe(false);
  });

  it("rejects a Windows drive letter and backslashes", () => {
    expect(safeJsonPath("C:/x.json")).toBe(false);
    expect(safeJsonPath("lineage-pilots\\x.json")).toBe(false);
  });

  it("rejects a .git path segment, case-insensitively", () => {
    expect(safeJsonPath("lineage-pilots/.git/config.json")).toBe(false);
    expect(safeJsonPath("lineage-pilots/.GIT/config.json")).toBe(false);
  });

  it("rejects raw control characters", () => {
    expect(safeJsonPath("lineage-pilots/x\u0000y.json")).toBe(false);
  });

  it("rejects a path that does not end in .json", () => {
    expect(safeJsonPath("lineage-pilots/x.txt")).toBe(false);
  });
});

describe("validPilotPath (SCR-47)", () => {
  const entry = {
    conference: "iclr-2026",
    paper_id: "1".repeat(40),
    artifact: { sha256: "a".repeat(64) },
    fixture: { sha256: "b".repeat(64) },
    quality: { sha256: "c".repeat(64) },
  };
  const goodPath = `lineage-pilots/${entry.conference}/${entry.paper_id}/artifacts/${entry.artifact.sha256}.json`;

  it("accepts exactly the deterministic path derived from the entry", () => {
    expect(validPilotPath(goodPath, entry, "artifact")).toBe(true);
  });

  it("rejects a literal .. traversal even when the suffix still matches", () => {
    const traversal = `lineage-pilots/../${entry.conference}/${entry.paper_id}/artifacts/${entry.artifact.sha256}.json`;
    expect(validPilotPath(traversal, entry, "artifact")).toBe(false);
  });

  it("rejects a path for a sibling file even if it is otherwise well-formed", () => {
    expect(
      validPilotPath(
        `lineage-pilots/${entry.conference}/${entry.paper_id}/artifacts/${"f".repeat(64)}.json`,
        entry,
        "artifact",
      ),
    ).toBe(false);
  });

  it("still rejects percent/query/fragment characters", () => {
    expect(validPilotPath(`${goodPath}?x=1`, entry, "artifact")).toBe(false);
    expect(validPilotPath(`${goodPath}#x`, entry, "artifact")).toBe(false);
    expect(validPilotPath(goodPath.replace("iclr-2026", "iclr%2D2026"), entry, "artifact")).toBe(
      false,
    );
  });
});
