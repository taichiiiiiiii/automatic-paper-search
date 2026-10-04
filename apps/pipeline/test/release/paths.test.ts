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

it("validateSmokeRelativePath rejects scheme/host/query/fragment/leading-slash/..", () => {
  expect(() => validateSmokeRelativePath("iclr-2026/")).not.toThrow();
  expect(() => validateSmokeRelativePath("https://evil.example/")).toThrow(PathSafetyError);
  expect(() => validateSmokeRelativePath("/iclr-2026/")).toThrow(PathSafetyError);
  expect(() => validateSmokeRelativePath("iclr-2026/?x=1")).toThrow(PathSafetyError);
  expect(() => validateSmokeRelativePath("iclr-2026/#frag")).toThrow(PathSafetyError);
  expect(() => validateSmokeRelativePath("../etc/passwd")).toThrow(PathSafetyError);
});
