/**
 * Typed fetch helpers for the lineage-related published JSON: the
 * quality manifest that gates everything (`lineage-quality-v1.json`),
 * conference/theme/deep lineage artifacts, deep manifests, and the
 * pilot index the Focus View uses. Kept separate from lib/data.ts per
 * the page-port brief ("add new typed helpers in a NEW file
 * lib/data-<area>.ts rather than editing data.ts").
 *
 * Every helper returns a `DataResult<T>` (see lib/data.ts) and never
 * throws; callers must render a distinct error state, never treat an
 * error as "no data".
 *
 * `fetchLineageArtifact` / `fetchDeepManifestFile` deliberately do NOT
 * fetch unless the caller already knows (from the quality manifest)
 * that the row is eligible -- see lib/lineage/core.ts
 * `qualityRowIsEligible` and SCR-25 ("品質行が適格で hash が一致しない限り
 * lineage.json を取得せず"). These helpers do not re-check eligibility
 * themselves; that decision belongs to the page, which must not call
 * them for an ineligible row.
 */
import { BASE_PATH } from "./config";
import type { DataResult } from "./data";
import {
  type DeepManifest,
  fetchJsonWithSha256,
  type LineageArtifact,
  parseDeepManifest,
  parseQualityManifest,
  type QualityManifest,
} from "./lineage/core";
import { type PilotIndex, parsePilotIndex } from "./lineage/pilot-index";

function publicPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`publicPath: path must start with "/", got ${JSON.stringify(path)}`);
  }
  return `${BASE_PATH}${path}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetches /lineage-quality-v1.json -- the publication gate every
 * lineage/deep/theme route must consult before fetching anything else. */
export async function fetchLineageQualityManifest(): Promise<DataResult<QualityManifest>> {
  try {
    const res = await fetch(publicPath("/lineage-quality-v1.json"), { cache: "no-cache" });
    if (!res.ok) {
      return {
        status: "error",
        error: `fetch /lineage-quality-v1.json failed: HTTP ${res.status}`,
      };
    }
    const parsed = parseQualityManifest(await res.json());
    if (!parsed) {
      return { status: "error", error: "lineage-quality-v1.json: failed strict validation" };
    }
    return { status: "ok", data: parsed };
  } catch (err) {
    return { status: "error", error: errorMessage(err) };
  }
}

/**
 * Fetches a lineage artifact (conference/theme/deep `lineage.json` /
 * `deep-*.json`) at a site-relative `path` (as given by a quality
 * row's `path`, e.g. "cvpr-2026/lineage.json"), bounding the body to
 * 8MB and hashing it before parsing. Returns `{status: "ok"}` only when
 * the hash matches `expectedSha256` -- a mismatch is an error, not a
 * reason to fall back to an unverified read.
 */
export async function fetchLineageArtifactBytes(
  path: string,
  expectedSha256: string,
): Promise<DataResult<{ raw: unknown; sha256: string }>> {
  const fetched = await fetchJsonWithSha256(
    publicPath(`/${path}`),
    { cache: "no-cache" },
    { expectedSha256 },
  );
  if (!fetched) {
    return {
      status: "error",
      error: `fetch /${path} failed, was oversized, or did not match the audited hash`,
    };
  }
  return { status: "ok", data: { raw: fetched.data, sha256: fetched.sha256 } };
}

export type { LineageArtifact };

/** Fetches /<conf>/deep-manifest.json (the picker entries for the deep
 * viewer). Not hash-gated on its own -- the quality manifest's deep
 * rows carry `manifest_input_sha256`; callers that need the gate must
 * hash this response themselves via `fetchJsonWithSha256` if they need
 * to bind to that hash (today, with 0 eligible deep rows, no caller
 * does -- the manifest is only used to render the not-ready picker). */
export async function fetchDeepManifestFile(
  conferenceSlug: string,
): Promise<DataResult<DeepManifest>> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(conferenceSlug)) {
    return {
      status: "error",
      error: `fetchDeepManifestFile: invalid slug ${JSON.stringify(conferenceSlug)}`,
    };
  }
  try {
    const res = await fetch(publicPath(`/${conferenceSlug}/deep-manifest.json`), {
      cache: "no-cache",
    });
    if (!res.ok) {
      return {
        status: "error",
        error: `fetch /${conferenceSlug}/deep-manifest.json failed: HTTP ${res.status}`,
      };
    }
    const parsed = parseDeepManifest(await res.json());
    if (!parsed) {
      return {
        status: "error",
        error: `${conferenceSlug}/deep-manifest.json: failed strict validation`,
      };
    }
    return { status: "ok", data: parsed };
  } catch (err) {
    return { status: "error", error: errorMessage(err) };
  }
}

/**
 * Fetches /<conf>/deep-manifest.json bounded + hashed (unlike
 * `fetchDeepManifestFile`), for the one caller that needs the hash to
 * check a deep quality row's `manifest_input_sha256` before trusting
 * which picker entries are eligible (SCR-27/SCR-28).
 */
export async function fetchDeepManifestBytes(
  conferenceSlug: string,
): Promise<DataResult<{ raw: unknown; sha256: string }>> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(conferenceSlug)) {
    return {
      status: "error",
      error: `fetchDeepManifestBytes: invalid slug ${JSON.stringify(conferenceSlug)}`,
    };
  }
  const fetched = await fetchJsonWithSha256(publicPath(`/${conferenceSlug}/deep-manifest.json`), {
    cache: "no-cache",
  });
  if (!fetched) {
    return {
      status: "error",
      error: `fetch /${conferenceSlug}/deep-manifest.json failed or was oversized`,
    };
  }
  return { status: "ok", data: { raw: fetched.data, sha256: fetched.sha256 } };
}

const PILOT_INDEX_MAX_BYTES = 256 * 1024;

/** Fetches /lineage-pilot-index-v1.json, bounded to 256KB (SCR-20). */
export async function fetchPilotIndex(): Promise<DataResult<PilotIndex>> {
  try {
    const res = await fetch(publicPath("/lineage-pilot-index-v1.json"), { cache: "no-cache" });
    if (!res.ok) {
      return {
        status: "error",
        error: `fetch /lineage-pilot-index-v1.json failed: HTTP ${res.status}`,
      };
    }
    const length = res.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > PILOT_INDEX_MAX_BYTES)) {
      return {
        status: "error",
        error: "lineage-pilot-index-v1.json: declared size exceeds the bound",
      };
    }
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > PILOT_INDEX_MAX_BYTES) {
      return { status: "error", error: "lineage-pilot-index-v1.json: body exceeds the bound" };
    }
    const parsed = parsePilotIndex(JSON.parse(text));
    if (!parsed) {
      return { status: "error", error: "lineage-pilot-index-v1.json: failed strict validation" };
    }
    return { status: "ok", data: parsed };
  } catch (err) {
    return { status: "error", error: errorMessage(err) };
  }
}
