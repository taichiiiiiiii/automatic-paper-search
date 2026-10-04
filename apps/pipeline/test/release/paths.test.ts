import { expect, it } from "vitest";
import {
  isDirPermitted,
  isFilePermitted,
  isUnderIncludedPath,
  PathSafetyError,
  validateAllowlistEntry,
  validateCandidateDirArg,
  validateIncludedPathArg,
  validateSmokeRelativePath,
} from "../../src/release/paths.js";

it("validateAllowlistEntry rejects absolute, empty, .. and .git paths", () => {
  expect(validateAllowlistEntry("docs/themes")).toEqual(["docs", "themes"]);
  expect(() => validateAllowlistEntry("/docs/themes")).toThrow(PathSafetyError);
  expect(() => validateAllowlistEntry("")).toThrow(PathSafetyError);
  expect(() => validateAllowlistEntry("docs/../etc")).toThrow(PathSafetyError);
  expect(() => validateAllowlistEntry("docs/.git/config")).toThrow(PathSafetyError);
});

it("isDirPermitted allows ancestors and descendants of an allowed prefix", () => {
  const allowed = [["docs", "themes", "new-theme"]];
  expect(isDirPermitted(["docs"], allowed)).toBe(true); // ancestor (walk must descend)
  expect(isDirPermitted(["docs", "themes"], allowed)).toBe(true);
  expect(isDirPermitted(["docs", "themes", "new-theme"], allowed)).toBe(true); // exact
  expect(isDirPermitted(["docs", "themes", "new-theme", "sub"], allowed)).toBe(true); // descendant
  expect(isDirPermitted(["docs", "other"], allowed)).toBe(false);
});

it("isFilePermitted does not allow a file at an ancestor path", () => {
  const allowed = [["docs", "themes", "new-theme"]];
  expect(isFilePermitted(["docs", "themes", "new-theme"], allowed)).toBe(true);
  expect(isFilePermitted(["docs", "themes", "new-theme", "lineage.json"], allowed)).toBe(true);
  expect(isFilePermitted(["docs"], allowed)).toBe(false);
  expect(isFilePermitted(["docs", "other"], allowed)).toBe(false);
});

it("validateIncludedPathArg rejects absolute, .., and traversal segments", () => {
  expect(() => validateIncludedPathArg("docs/themes")).not.toThrow();
  expect(() => validateIncludedPathArg("")).toThrow(PathSafetyError);
  expect(() => validateIncludedPathArg("/etc")).toThrow(PathSafetyError);
  expect(() => validateIncludedPathArg("..")).toThrow(PathSafetyError);
  expect(() => validateIncludedPathArg("../etc")).toThrow(PathSafetyError);
  expect(() => validateIncludedPathArg("docs/../etc")).toThrow(PathSafetyError);
  expect(() => validateIncludedPathArg("docs/..")).toThrow(PathSafetyError);
});

it("isUnderIncludedPath matches exact and nested paths only", () => {
  const included = ["docs/themes"];
  expect(isUnderIncludedPath("docs/themes", included)).toBe(true);
  expect(isUnderIncludedPath("docs/themes/new/lineage.json", included)).toBe(true);
  expect(isUnderIncludedPath("docs/themesX", included)).toBe(false);
  expect(isUnderIncludedPath("README.md", included)).toBe(false);
});

it("validateCandidateDirArg requires an absolute path outside the repo", () => {
  expect(() => validateCandidateDirArg("/tmp/candidate", "/repo")).not.toThrow();
  expect(() => validateCandidateDirArg("relative/candidate", "/repo")).toThrow(PathSafetyError);
  expect(() => validateCandidateDirArg("/repo", "/repo")).toThrow(PathSafetyError);
  expect(() => validateCandidateDirArg("/repo/candidate", "/repo")).toThrow(PathSafetyError);
});

it("validateSmokeRelativePath accepts an ordinary relative path", () => {
  expect(() => validateSmokeRelativePath("iclr-2026/")).not.toThrow();
});

// PUB-36: each unsafe-path clause gets its own input, isolated from the
// others, so a mutant that disables ONE clause can't hide behind a
// different clause in the same input also catching it (the single
// combined "https://evil.example/" case used to cover scheme AND netloc
// at once, for example, so deleting either check alone stayed green).
it("PUB-36: rejects a scheme (mailto:, no host/netloc) on its own", () => {
  expect(() => validateSmokeRelativePath("mailto:evil@example.com")).toThrow(PathSafetyError);
});

it("PUB-36: rejects a scheme+host URL (the realistic absolute-URL case)", () => {
  expect(() => validateSmokeRelativePath("https://evil.example/")).toThrow(PathSafetyError);
});

it("PUB-36: rejects a single leading slash, isolated from netloc", () => {
  // Exactly one leading "/" (not "//"), so `netloc` stays empty here —
  // this input can only be caught by the leading-slash check itself.
  expect(() => validateSmokeRelativePath("/iclr-2026/")).toThrow(PathSafetyError);
});

it("PUB-36: rejects a protocol-relative //host path", () => {
  // Note: any `//host` path necessarily also starts with "/", so this
  // input is mathematically never isolated from the leading-slash check
  // (by the time `netloc` would be the deciding clause, the leading-slash
  // check has already decided it) — the dedicated netloc computation
  // cannot be isolated by any input to this function. This case is kept
  // as a real-world regression pin, not a netloc-isolation proof.
  expect(() => validateSmokeRelativePath("//evil.example/path")).toThrow(PathSafetyError);
});

it("PUB-36: rejects a query string, isolated from the other clauses", () => {
  expect(() => validateSmokeRelativePath("iclr-2026/?x=1")).toThrow(PathSafetyError);
});

it("PUB-36: rejects a fragment, isolated from the other clauses", () => {
  expect(() => validateSmokeRelativePath("iclr-2026/#frag")).toThrow(PathSafetyError);
});

it("PUB-36: rejects a .. path segment, isolated from the other clauses", () => {
  expect(() => validateSmokeRelativePath("../etc/passwd")).toThrow(PathSafetyError);
  expect(() => validateSmokeRelativePath("iclr-2026/../../etc/passwd")).toThrow(PathSafetyError);
});
