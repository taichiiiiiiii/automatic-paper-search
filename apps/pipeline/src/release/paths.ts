/**
 * Relative-path safety helpers shared by the Node release scripts
 * (promoter, candidate packager, release validator).
 *
 * `docs/migration/safety-contracts.md` targets `packages/core/paths` for
 * PUB-05 and RPL-09 (a path-safety helper shared with the catalog/replay
 * code). This change's edit limits restrict it to
 * `apps/pipeline/src/release/**`, so the logic lives here instead; see the
 * final report for the consolidation follow-up.
 */

export class PathSafetyError extends Error {}

/** `PurePosixPath(raw).parts` for the subset this module needs: split on `/`, drop empty and `.` segments. */
function posixParts(raw: string): string[] {
  return raw.split("/").filter((part) => part !== "" && part !== ".");
}

/**
 * Port of `promote-generated.sh`'s inline Python allowlist-entry check
 * (PUB-05): reject an absolute path, an empty path, or any `..`/`.git`
 * segment. Returns the path's POSIX parts on success.
 */
export function validateAllowlistEntry(raw: string): string[] {
  const parts = posixParts(raw);
  if (raw.startsWith("/") || parts.length === 0 || parts.includes("..") || parts.includes(".git")) {
    throw new PathSafetyError(`invalid allowlist path: ${JSON.stringify(raw)}`);
  }
  return parts;
}

function isPrefixOf(prefix: string[], parts: string[]): boolean {
  if (prefix.length >= parts.length) return false;
  return prefix.every((segment, i) => segment === parts[i]);
}

function partsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * Port of the candidate-walk permission check in `promote-generated.sh`'s
 * inline Python (PUB-05/06): a directory is permitted if it equals an
 * allowed prefix, is an ancestor of one (so the walk can descend into it),
 * or is a descendant of one.
 */
export function isDirPermitted(relParts: string[], allowed: string[][]): boolean {
  return allowed.some(
    (prefix) =>
      partsEqual(relParts, prefix) || isPrefixOf(prefix, relParts) || isPrefixOf(relParts, prefix),
  );
}

/** Same check for a file: it must equal an allowed path or be a descendant of one (a file cannot be an ancestor). */
export function isFilePermitted(relParts: string[], allowed: string[][]): boolean {
  return allowed.some((prefix) => partsEqual(relParts, prefix) || isPrefixOf(prefix, relParts));
}

/**
 * Port of `package-generated-candidate.sh`'s included-path argument check:
 * non-empty, not absolute, and not `..`/`../...`/`.../../...`/`.../..`.
 */
export function validateIncludedPathArg(raw: string): void {
  if (
    raw === "" ||
    raw.startsWith("/") ||
    raw === ".." ||
    raw.startsWith("../") ||
    raw.includes("/../") ||
    raw.endsWith("/..")
  ) {
    throw new PathSafetyError(`invalid included path: ${raw}`);
  }
}

/** Port of `package-generated-candidate.sh`'s `is_included()`: prefix match on the raw string, path-segment aware. */
export function isUnderIncludedPath(path: string, includedPaths: readonly string[]): boolean {
  return includedPaths.some((included) => path === included || path.startsWith(`${included}/`));
}

/**
 * Port of `package-generated-candidate.sh`'s candidate-directory argument
 * check: must be absolute and outside the repository root.
 */
export function validateCandidateDirArg(candidateDir: string, repoRoot: string): void {
  if (!candidateDir.startsWith("/")) {
    throw new PathSafetyError("candidate directory must be absolute");
  }
  if (candidateDir === repoRoot || candidateDir.startsWith(`${repoRoot}/`)) {
    throw new PathSafetyError("candidate directory must be outside the repository");
  }
}

/**
 * Port of `validate-pages-release.sh`'s smoke-path safety check (PUB-36):
 * reject a scheme, host, query, fragment, leading slash, or `..` segment.
 */
export function validateSmokeRelativePath(relative: string): void {
  let scheme = "";
  let rest = relative;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(rest);
  if (schemeMatch) {
    scheme = schemeMatch[1] as string;
    rest = rest.slice(schemeMatch[0].length);
  }
  let netloc = "";
  if (rest.startsWith("//")) {
    let end = rest.length;
    for (const ch of ["/", "?", "#"]) {
      const idx = rest.indexOf(ch, 2);
      if (idx >= 0) end = Math.min(end, idx);
    }
    netloc = rest.slice(2, end);
    rest = rest.slice(end);
  }
  const hashIdx = rest.indexOf("#");
  const fragment = hashIdx >= 0 ? rest.slice(hashIdx + 1) : "";
  if (hashIdx >= 0) rest = rest.slice(0, hashIdx);
  const qIdx = rest.indexOf("?");
  const query = qIdx >= 0 ? rest.slice(qIdx + 1) : "";
  if (qIdx >= 0) rest = rest.slice(0, qIdx);
  const path = rest;

  if (
    scheme ||
    netloc ||
    query ||
    fragment ||
    relative.startsWith("/") ||
    path.split("/").includes("..")
  ) {
    throw new PathSafetyError(`unsafe smoke path: ${JSON.stringify(relative)}`);
  }
}
