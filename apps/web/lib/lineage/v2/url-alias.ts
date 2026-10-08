/**
 * URL, DOI/alias and JSON-path validation for the lineage-v2 contract
 * -- ported 1:1 from docs/assets/lineage-v2-core.js. `safeJsonPath` /
 * `validPilotPath` are the traversal/percent-encoding defenses named
 * directly in safety-contracts.md SCR-47 ("pilot の索引・成果物パスは
 * traversal・パーセント・query・絶対形を拒否"); `validAlias`'s DOI branch
 * is the "percent-decoded DOI aliases must already be canonical" test
 * case in test_lineage_v2_core.mjs.
 */
import { ALIAS_NAMESPACES, type AliasNamespace } from "./constants";

export function validHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.length > 0;
  } catch {
    return false;
  }
}

/** Validates one `[namespace, value]` alias pair. The DOI branch
 * percent-decodes `value` as UTF-8 octets and requires the decoded
 * form, lower-cased and trimmed, to equal `value` byte-for-byte --
 * i.e. an alias must already be in its single canonical form, never
 * one of several encodings that decode to the same DOI. */
export function validAlias(namespace: unknown, value: unknown): boolean {
  if (
    !ALIAS_NAMESPACES.has(namespace as AliasNamespace) ||
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) {
    return false;
  }
  if (namespace === "arxiv") {
    if (/^\d{4}\.\d{4,5}$/.test(value)) return true;
    const legacy = /^([A-Za-z][A-Za-z0-9.-]*)\/(\d{7})$/.exec(value);
    if (!legacy || /v\d+$/.test(value)) return false;
    const prefix = legacy[1] as string;
    const archive = prefix.includes(".")
      ? `${prefix.split(".", 1)[0]?.toLowerCase()}${prefix.slice(prefix.indexOf("."))}`
      : prefix.toLowerCase();
    return value === `${archive}/${legacy[2]}`;
  }
  if (namespace === "openreview") return /^[A-Za-z0-9_-]{1,256}$/.test(value);
  if (namespace === "acl_anthology" || namespace === "cvf") {
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$/.test(value);
  }
  // namespace === "doi"
  let decoded: string;
  try {
    const octets: number[] = [];
    for (let index = 0; index < value.length; ) {
      const percentEscape = /^%([0-9A-Fa-f]{2})/.exec(value.slice(index));
      if (percentEscape) {
        octets.push(Number.parseInt(percentEscape[1] as string, 16));
        index += 3;
      } else {
        const character = String.fromCodePoint(value.codePointAt(index) as number);
        octets.push(...new TextEncoder().encode(character));
        index += character.length;
      }
    }
    decoded = new TextDecoder("utf-8", { fatal: true })
      .decode(new Uint8Array(octets))
      .trim()
      .toLowerCase();
  } catch {
    return false;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: excluding control chars from the DOI suffix is the point (ported from docs/assets/lineage-v2-core.js).
  return decoded === value && /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/.test(decoded);
}

/** Rejects absolute paths, drive letters, backslashes, control
 * characters, `.`/`..`/`.git` path segments, and anything not ending
 * in `.json`. Does NOT reject `%`/`?`/`#` on its own -- `validPilotPath`
 * layers that on top, since `safeJsonPath` is also used (unmodified)
 * for contexts that do not need the percent/query/fragment ban. */
export function safeJsonPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.endsWith(".json") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting raw control characters in a path is the point (ported from lineage-v2-core.js).
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return parts.every(
    (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
  );
}

export type PilotPathKind = "artifact" | "fixture" | "quality";

interface PilotPathEntry {
  conference: string;
  paper_id: string;
  artifact: { sha256: string };
  fixture: { sha256: string };
  quality: { sha256: string };
}

/** `value` must be exactly the deterministic path the publisher
 * derives from `entry` -- `lineage-pilots/<conference>/<paper_id>/
 * <artifacts|fixtures|quality>/<sha256>.json` -- so a release can never
 * point at an arbitrary sibling file even if it is otherwise
 * well-formed JSON at a `safeJsonPath`. */
export function validPilotPath(
  value: unknown,
  entry: PilotPathEntry,
  kind: PilotPathKind,
): boolean {
  if (
    !safeJsonPath(value) ||
    (value as string).includes("%") ||
    (value as string).includes("?") ||
    (value as string).includes("#")
  ) {
    return false;
  }
  const directory = kind === "artifact" ? "artifacts" : kind === "fixture" ? "fixtures" : "quality";
  return (
    value ===
    `lineage-pilots/${entry.conference}/${entry.paper_id}/${directory}/${entry[kind].sha256}.json`
  );
}
