/**
 * lib/lineage/server-fs.ts `listConferenceSlugsWithFile` -- P2 review
 * LOW: a failed top-level `readdir(docs/)` (missing/unreadable
 * `docs/`, a build-environment error) used to be swallowed into an
 * empty array, which `generateStaticParams` (app/[conf]/lineage/
 * layout.tsx, app/[conf]/deep/layout.tsx) would read as "zero
 * conferences are eligible" and silently build NO routes for the
 * entire site, instead of failing the build loudly. The per-conference
 * `stat` (missing file for ONE conference) must stay non-fatal --
 * that is the legitimate "this conference doesn't have this file yet"
 * case.
 */
import { describe, expect, it } from "vitest";
import { listConferenceSlugsWithFile } from "../../lib/lineage/server-fs";

describe("listConferenceSlugsWithFile: real docs/ (positive path, unmocked)", () => {
  it("lists conferences that actually have papers.json, sorted", async () => {
    const slugs = await listConferenceSlugsWithFile("papers.json");
    expect(slugs).toContain("iclr-2026");
    expect([...slugs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(slugs);
  });

  it("excludes conferences that lack the named file, without erroring", async () => {
    // No conference ships this filename -- a per-conference `stat`
    // miss must produce an empty result, not throw.
    const slugs = await listConferenceSlugsWithFile("this-file-does-not-exist.json");
    expect(slugs).toEqual([]);
  });
});
