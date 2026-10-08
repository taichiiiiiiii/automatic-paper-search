import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertConferenceHasPapersJson } from "../../app/[conf]/paper-links/build-guard";

/**
 * Review finding M1: a conference listed in conferences.json whose
 * `<conf>/papers.json` is missing used to still get `/[conf]/`,
 * `/[conf]/paper-links/` routes generated; the paper-links page would
 * then call `notFound()`, which a static export writes as a 200-status
 * page that looks like a 404 instead of failing the build. This guard
 * is the fix: both routes' `generateStaticParams` call it per
 * conference before the function returns any params for it.
 */
describe("assertConferenceHasPapersJson", () => {
  it("does not throw when <conf>/papers.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-guard-"));
    try {
      mkdirSync(join(dir, "cvpr-2026"));
      writeFileSync(join(dir, "cvpr-2026", "papers.json"), "[]");
      expect(() => assertConferenceHasPapersJson("cvpr-2026", dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws (failing the build) when <conf>/papers.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-guard-"));
    try {
      expect(() => assertConferenceHasPapersJson("ghost-conf-2099", dir)).toThrow(/papers\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the conference directory itself does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-guard-"));
    try {
      expect(() => assertConferenceHasPapersJson("nope", dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
