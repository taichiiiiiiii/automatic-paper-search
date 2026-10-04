/**
 * Port of `paperpilot/tests/test_scripts_common.py::test_validate_conference_slug_*`.
 */
import { describe, expect, it } from "vitest";
import {
  InvalidConferenceSlugError,
  validateConferenceSlug,
} from "../../../src/conference/shared/conferenceSlug.js";

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
});
