/**
 * R3-6: reader for a conference's input-side `external_ids.json` (written by
 * `linkExternalIdsCli.ts`, R3-5) so `buildPages` can publish the OpenReview
 * forum id of conference_site rows. Kept free of the linker's imports
 * (which depend on buildPages) to avoid an import cycle.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const EXTERNAL_IDS_SCHEMA = "conference-external-ids-v1";
export const EXTERNAL_IDS_FILENAME = "external_ids.json";

const OPENREVIEW_FORUM_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * `paper_id` -> OpenReview forum id from the `external_ids.json` next to
 * `summaryCsv`; empty when there is none. A malformed file throws (fail
 * closed instead of silently publishing no / wrong aliases).
 */
export function loadOpenreviewIds(summaryCsv: string): Map<string, string> {
  const path = join(dirname(summaryCsv), EXTERNAL_IDS_FILENAME);
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  const file = JSON.parse(readFileSync(path, "utf-8")) as {
    schema_version?: unknown;
    papers?: unknown;
  } | null;
  if (!file || file.schema_version !== EXTERNAL_IDS_SCHEMA || !Array.isArray(file.papers)) {
    throw new Error(`external ids: schema_version must be ${EXTERNAL_IDS_SCHEMA}`);
  }
  const byForum = new Map<string, string>();
  for (const p of file.papers as Array<Record<string, unknown>>) {
    const id = p?.paper_id;
    const forum = p?.openreview_id;
    if (typeof id !== "string" || !/^[0-9a-f]{40}$/.test(id)) {
      throw new Error("external ids: invalid paper_id");
    }
    if (forum === undefined || forum === null) continue;
    if (typeof forum !== "string" || !OPENREVIEW_FORUM_ID_RE.test(forum)) {
      throw new Error(`external ids: invalid OpenReview forum id for ${id}`);
    }
    const prev = byForum.get(forum);
    if (prev !== undefined && prev !== id) {
      throw new Error(`external ids: OpenReview forum ${forum} claimed by two papers`);
    }
    byForum.set(forum, id);
    out.set(id, forum);
  }
  return out;
}
