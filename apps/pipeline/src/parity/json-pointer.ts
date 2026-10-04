/**
 * Minimal RFC 6901 JSON Pointer helpers, extended with a `*` wildcard segment
 * (matches any single key/index) so a rules file can ignore a field inside every
 * element of an array, e.g. "/items/*\/generated_at".
 */

export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON pointer (must start with "/" or be ""): ${pointer}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function formatPointer(segments: readonly string[]): string {
  if (segments.length === 0) return "";
  return `/${segments.map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

/** True if `pattern` (a parsed pointer, `*` segments allowed) matches `actual` exactly (same length). */
export function pointerMatches(pattern: readonly string[], actual: readonly string[]): boolean {
  if (pattern.length !== actual.length) return false;
  return pattern.every((segment, i) => segment === "*" || segment === actual[i]);
}

/** True if `actual` is matched by any pattern in `patterns`. */
export function isIgnored(
  patterns: readonly (readonly string[])[],
  actual: readonly string[],
): boolean {
  return patterns.some((pattern) => pointerMatches(pattern, actual));
}
