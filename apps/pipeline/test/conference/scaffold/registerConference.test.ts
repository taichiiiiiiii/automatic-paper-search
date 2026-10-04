/**
 * Port of `paperpilot/tests/test_scaffold_conference_page.py` (CNF-20/21,
 * docs/migration/safety-contracts.md), redesigned for `registerConference`
 * — see that module's doc comment for why there is no HTML/lineage.json
 * equivalent left to test (the new site has no per-conference template and
 * `lineage/route-eligibility.ts` already treats a missing lineage artifact
 * as "no lineage route", not a 404 to paper over).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ConferenceAlreadyRegisteredError,
  registerConference,
} from "../../../src/conference/scaffold/registerConference.js";

let manifestPath: string;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-test-"));
  manifestPath = join(dir, "catalog-copy.json");
});

describe("registerConference", () => {
  it("writes a new manifest entry", () => {
    const manifest = registerConference("neurips-2026", "NeurIPS 2026", "A lede.", manifestPath);
    expect(manifest["neurips-2026"]).toEqual({ display: "NeurIPS 2026", lede: "A lede." });
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(onDisk["neurips-2026"]).toEqual({ display: "NeurIPS 2026", lede: "A lede." });
  });

  it("CNF-20: refuses to overwrite an existing conference registration", () => {
    registerConference("neurips-2026", "NeurIPS 2026", "A lede.", manifestPath);
    expect(() =>
      registerConference("neurips-2026", "Different", "Different.", manifestPath),
    ).toThrow(ConferenceAlreadyRegisteredError);
    // The original entry must survive the rejected second call untouched.
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(onDisk["neurips-2026"].display).toBe("NeurIPS 2026");
  });

  it("CNF-20: rejects unsafe (path traversal / uppercase) conference slugs", () => {
    expect(() => registerConference("../../etc", "X", "Y", manifestPath)).toThrow();
    expect(() => registerConference("CVPR 2026", "X", "Y", manifestPath)).toThrow();
  });

  it("CNF-20: rejects reserved top-level slugs", () => {
    // "daily" is rejected by the shared `validateConferenceSlug` itself
    // (InvalidConferenceSlugError); the rest are rejected by this
    // module's own additional reserved-path check (RangeError) — see
    // RESERVED_CONFERENCE_SLUGS's doc comment for why both exist.
    for (const reserved of ["daily", "themes", "lineage", "how-it-works", "research"]) {
      expect(() => registerConference(reserved, "X", "Y", manifestPath)).toThrow();
    }
  });

  it("CNF-20: a rejected registration leaves no manifest behind so a rerun is possible", () => {
    expect(() => registerConference("daily", "X", "Y", manifestPath)).toThrow();
    expect(() =>
      registerConference("neurips-2026", "NeurIPS 2026", "ok", manifestPath),
    ).not.toThrow();
  });

  it("CNF-21: rejects control characters in display/lede (plain text only)", () => {
    expect(() =>
      registerConference("neurips-2026", "NeurIPS\x00 2026", "ok", manifestPath),
    ).toThrow();
    expect(() =>
      registerConference("neurips-2026", "NeurIPS 2026", "ok\x1b[31m", manifestPath),
    ).toThrow();
  });

  it("CNF-21: stores display/lede verbatim as plain data, no HTML escaping applied (nothing left to inject into)", () => {
    const manifest = registerConference(
      "neurips-2026",
      "<script>alert(1)</script>",
      "lede with & and <tags>",
      manifestPath,
    );
    expect(manifest["neurips-2026"]).toEqual({
      display: "<script>alert(1)</script>",
      lede: "lede with & and <tags>",
    });
  });

  it("rejects empty display/lede", () => {
    expect(() => registerConference("neurips-2026", "", "ok", manifestPath)).toThrow();
    expect(() => registerConference("neurips-2026", "ok", "   ", manifestPath)).toThrow();
  });
});
