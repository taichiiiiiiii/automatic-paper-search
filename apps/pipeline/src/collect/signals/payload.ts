/**
 * Element-level validation for fetched payloads — TS port of the subset of
 * `paperpilot/utils/payload.py` that this port's GitHub signal needs:
 * `first_unusable`, `gh_repo_slug`, `gh_search_item_ok` (OUT-17, OUT-19,
 * OUT-24 of docs/migration/safety-contracts.md).
 *
 * INTENTIONAL SCOPE NARROWING: the Python module also defines
 * `s2_paper_shape`, `openalex_work_shape`, `s2_relation_entry_ok`,
 * `s2_cached_neighbour_ok`, `openalex_short_id` (OUT-20..23) — those back the
 * lineage/theme builders (`paperpilot/scripts/build_*lineage*.py`), which are
 * P4d, not this task's scope (collect/signals/exporters/stages/runner/CLI).
 * Nothing in `apps/pipeline/src/collect/**` calls them. Omitted rather than
 * speculatively ported.
 */

/**
 * The first element the consumer's own predicate cannot use.
 *
 * Returns `[index, element]` or `null` when every element passes. A
 * predicate that throws counts as a failed check, so the caller does not
 * have to pre-guard types (mirrors Python's `try: usable(item) except
 * Exception: pass` -> falls through to "unusable").
 *
 * `allowNone` is for the one array where a hole is the answer: S2's
 * `/paper/batch` returns `null` in place for an id it does not know.
 */
export function firstUnusable<T>(
  items: readonly T[],
  usable: (item: T) => boolean,
  options: { allowNone?: boolean } = {},
): [number, T] | null {
  const allowNone = options.allowNone ?? false;
  for (let index = 0; index < items.length; index++) {
    const item = items[index] as T;
    if (allowNone && item === null) continue;
    try {
      if (usable(item)) continue;
    } catch {
      // a predicate that throws is a failed check
    }
    return [index, item];
  }
  return null;
}

// `^[A-Za-z0-9][A-Za-z0-9._-]*$` — fullmatch (Python's `$` also matches
// before a trailing newline; JS's `$` without `/m` does the same for
// `\n` specifically, so a literal `\n$` guard is added at the call site via
// an explicit check rather than relying on the regex alone).
const GH_SLUG_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `"owner/repo"` -> `["owner", "repo"]` when both halves are valid slugs,
 * else `null`. The slug shape is a security boundary (SSRF / path
 * traversal), so the same function backs validation of a search page and
 * consumption of each item.
 *
 * Python's `_GH_SLUG_SEGMENT_RE.fullmatch` is defeated by a trailing
 * newline only because Python's `$` (without `re.MULTILINE`) still matches
 * just before a final `\n` — `"owner/repo\n"` passes `fullmatch` there. JS's
 * `^...$` anchors (no `/m` flag) require the ENTIRE string to match with no
 * trailing newline allowance, so `GH_SLUG_SEGMENT_RE.test("repo\n")` is
 * already `false` in JS — the Python test `test_gh_repo_slug_rejects_a_
 * trailing_newline` passes here for a different (stricter-by-default)
 * reason. Documented, not a behavior gap (both reject it).
 */
export function ghRepoSlug(value: unknown): [owner: string, repo: string] | null {
  if (typeof value !== "string" || !value.includes("/")) return null;
  const slashIndex = value.indexOf("/");
  const owner = value.slice(0, slashIndex);
  const name = value.slice(slashIndex + 1);
  if (!GH_SLUG_SEGMENT_RE.test(owner) || !GH_SLUG_SEGMENT_RE.test(name)) return null;
  return [owner, name];
}

/**
 * One GitHub repository-search item the matcher can consume. `full_name`
 * must be a valid slug; `name` is always a string on a real repository and
 * `description` is a string or null.
 */
export function ghSearchItemOk(item: unknown): boolean {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
  const rec = item as Record<string, unknown>;
  if (ghRepoSlug(rec.full_name) === null) return false;
  const description = rec.description;
  return typeof rec.name === "string" && (description === null || typeof description === "string");
}
