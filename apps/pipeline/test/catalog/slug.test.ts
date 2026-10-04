/** Ported from paperpilot/tests/test_scripts_common.py's validate_conference_slug tests. */
import { describe, expect, it } from "vitest";
import { validateConferenceSlug } from "../../src/catalog/slug.js";

describe("validateConferenceSlug", () => {
  it("accepts valid slugs", () => {
    for (const good of ["cvpr-2026", "iclr-2026", "emnlp-findings-2025", "acl2025", "a"]) {
      expect(validateConferenceSlug(good)).toBe(good);
    }
  });

  it("rejects path traversal", () => {
    for (const bad of ["../../etc/passwd", "..", "/etc/passwd", "cvpr/../escape", "a/b"]) {
      expect(() => validateConferenceSlug(bad)).toThrow();
    }
  });

  it("rejects non-slug shapes", () => {
    for (const bad of ["", "CVPR-2026", "cvpr 2026", "cvpr_2026", "-cvpr", "cvpr-", "cvpr--2026"]) {
      expect(() => validateConferenceSlug(bad)).toThrow();
    }
  });

  it("rejects a trailing newline (regression: $ must not match before \\n)", () => {
    for (const bad of ["cvpr-2026\n", "cvpr-2026\n\n", "\ncvpr-2026"]) {
      expect(() => validateConferenceSlug(bad)).toThrow();
    }
  });

  it("rejects the reserved name 'daily'", () => {
    expect(() => validateConferenceSlug("daily")).toThrow();
  });

  it("rejects overlong input but accepts exactly 64 chars", () => {
    expect(() => validateConferenceSlug("a".repeat(65))).toThrow();
    expect(validateConferenceSlug("a".repeat(64))).toBe("a".repeat(64));
  });
});
