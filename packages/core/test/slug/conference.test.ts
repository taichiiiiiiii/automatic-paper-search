/**
 * Port of `paperpilot/tests/test_scripts_common.py::test_validate_conference_slug_*`.
 *
 * Merges the two formerly-duplicated suites around this validator
 * (`apps/pipeline/src/catalog/slug.ts` and
 * `apps/pipeline/src/conference/shared/conferenceSlug.ts`) per
 * docs/migration/p4-followups.md #2/#9/#20.
 */
import { describe, expect, it } from "vitest";
import { InvalidConferenceSlugError, validateConferenceSlug } from "../../src/slug/conference.js";

describe("validateConferenceSlug", () => {
  it("accepts valid slugs", () => {
    for (const good of ["cvpr-2026", "iclr-2026", "emnlp-findings-2025", "acl2025", "a"]) {
      expect(validateConferenceSlug(good)).toBe(good);
    }
  });

  it("rejects path traversal", () => {
    for (const bad of ["../../etc/passwd", "..", "/etc/passwd", "cvpr/../escape", "a/b"]) {
      expect(() => validateConferenceSlug(bad)).toThrow(InvalidConferenceSlugError);
    }
  });

  it("rejects non-slug shapes", () => {
    for (const bad of ["", "CVPR-2026", "cvpr 2026", "cvpr_2026", "-cvpr", "cvpr-", "cvpr--2026"]) {
      expect(() => validateConferenceSlug(bad)).toThrow(InvalidConferenceSlugError);
    }
  });

  it("rejects a trailing newline (JS `$` is already fullmatch-equivalent here)", () => {
    for (const bad of ["cvpr-2026\n", "cvpr-2026\n\n", "\ncvpr-2026"]) {
      expect(() => validateConferenceSlug(bad)).toThrow(InvalidConferenceSlugError);
    }
  });

  it("rejects the reserved name 'daily'", () => {
    expect(() => validateConferenceSlug("daily")).toThrow(InvalidConferenceSlugError);
  });

  it("rejects overlong input but accepts exactly 64 chars", () => {
    expect(() => validateConferenceSlug("a".repeat(65))).toThrow(InvalidConferenceSlugError);
    expect(validateConferenceSlug("a".repeat(64))).toBe("a".repeat(64));
  });

  it("the one error type is also a RangeError (backward-compat: former catalog/slug.ts threw plain RangeError)", () => {
    expect(() => validateConferenceSlug("")).toThrow(RangeError);
  });
});
