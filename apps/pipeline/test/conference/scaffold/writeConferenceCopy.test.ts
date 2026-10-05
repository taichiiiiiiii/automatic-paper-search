/**
 * Unit tests for `writeConferenceCopyFile` — p5-plan.md §2 A2: "Writes
 * ONE FILE PER SLUG: `<layout.config>/conference-copy/<slug>.json`. A
 * shared manifest would make two concurrent conference promotions fail
 * the CAS 'paths changed on develop' check." Also: "Rejects
 * `RESERVED_CONFERENCE_SLUGS`."
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeConferenceCopyFile } from "../../../src/conference/scaffold/writeConferenceCopy.js";
import { InvalidConferenceSlugError } from "../../../src/conference/shared/index.js";

let copyDir: string;

beforeEach(() => {
  copyDir = mkdtempSync(join(tmpdir(), "conference-copy-"));
});
afterEach(() => {
  rmSync(copyDir, { recursive: true, force: true });
});

describe("writeConferenceCopyFile", () => {
  it("writes <slug>.json with display/lede", () => {
    const path = writeConferenceCopyFile(
      "neurips-2026",
      { display: "NeurIPS 2026", lede: "A lede." },
      copyDir,
    );
    expect(path).toBe(join(copyDir, "neurips-2026.json"));
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      display: "NeurIPS 2026",
      lede: "A lede.",
    });
  });

  it("creates copyDir if it doesn't exist yet", () => {
    const nested = join(copyDir, "nested", "deeper");
    const path = writeConferenceCopyFile("neurips-2026", { display: "X", lede: "Y" }, nested);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ display: "X", lede: "Y" });
  });

  it("two DIFFERENT slugs get two independent files (no shared-manifest collision)", () => {
    writeConferenceCopyFile("aaa-2026", { display: "A", lede: "a" }, copyDir);
    writeConferenceCopyFile("bbb-2026", { display: "B", lede: "b" }, copyDir);
    expect(JSON.parse(readFileSync(join(copyDir, "aaa-2026.json"), "utf-8")).display).toBe("A");
    expect(JSON.parse(readFileSync(join(copyDir, "bbb-2026.json"), "utf-8")).display).toBe("B");
  });

  it("re-running for the SAME slug overwrites (unlike registerConference's shared-manifest no-overwrite guard — a per-slug file may legitimately be refreshed)", () => {
    writeConferenceCopyFile("neurips-2026", { display: "Old", lede: "old" }, copyDir);
    const path = writeConferenceCopyFile("neurips-2026", { display: "New", lede: "new" }, copyDir);
    expect(JSON.parse(readFileSync(path, "utf-8")).display).toBe("New");
  });

  it("rejects an unsafe/invalid slug", () => {
    expect(() =>
      writeConferenceCopyFile("../../etc", { display: "X", lede: "Y" }, copyDir),
    ).toThrow(InvalidConferenceSlugError);
    expect(() =>
      writeConferenceCopyFile("CVPR 2026", { display: "X", lede: "Y" }, copyDir),
    ).toThrow(InvalidConferenceSlugError);
  });

  it("rejects the reserved slug 'daily'", () => {
    expect(() => writeConferenceCopyFile("daily", { display: "X", lede: "Y" }, copyDir)).toThrow(
      InvalidConferenceSlugError,
    );
  });

  it("rejects the reserved slug 'lineage' (added to core's RESERVED_CONFERENCE_SLUGS, p5-plan.md §4.1)", () => {
    expect(() => writeConferenceCopyFile("lineage", { display: "X", lede: "Y" }, copyDir)).toThrow(
      InvalidConferenceSlugError,
    );
  });

  // L6 (P5 tier-A review): writeConferenceCopyFile used to only reject
  // {daily, lineage} -- far fewer reserved names than
  // registerConference.ts's own, separate, broader list. Now that core's
  // RESERVED_CONFERENCE_SLUGS is the single canonical list (both scaffold
  // modules go through it), writeConferenceCopyFile rejects every one of
  // these the same way registerConference always did.
  it("rejects every reserved top-level route slug (single canonical list, L6)", () => {
    for (const reserved of [
      "themes",
      "how-it-works",
      "assets",
      "design",
      "paper-details-v1",
      "paper-slides-v1",
      "research",
      "search-paper-ids-v1",
    ]) {
      expect(() => writeConferenceCopyFile(reserved, { display: "X", lede: "Y" }, copyDir)).toThrow(
        InvalidConferenceSlugError,
      );
    }
  });

  it("still accepts the real conference 'cvpr-2026' (deliberately not reserved -- see core's doc comment)", () => {
    const path = writeConferenceCopyFile("cvpr-2026", { display: "X", lede: "Y" }, copyDir);
    expect(JSON.parse(readFileSync(path, "utf-8")).display).toBe("X");
  });

  it("rejects empty display/lede", () => {
    expect(() =>
      writeConferenceCopyFile("neurips-2026", { display: "", lede: "ok" }, copyDir),
    ).toThrow();
    expect(() =>
      writeConferenceCopyFile("neurips-2026", { display: "ok", lede: "   " }, copyDir),
    ).toThrow();
  });

  it("rejects control characters in display/lede (CNF-21)", () => {
    expect(() =>
      writeConferenceCopyFile("neurips-2026", { display: "X\x00", lede: "ok" }, copyDir),
    ).toThrow();
    expect(() =>
      writeConferenceCopyFile("neurips-2026", { display: "ok", lede: "ok\x1b[31m" }, copyDir),
    ).toThrow();
  });

  it("stores display/lede verbatim, no HTML escaping applied", () => {
    const path = writeConferenceCopyFile(
      "neurips-2026",
      { display: "<script>alert(1)</script>", lede: "lede with & and <tags>" },
      copyDir,
    );
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      display: "<script>alert(1)</script>",
      lede: "lede with & and <tags>",
    });
  });
});
