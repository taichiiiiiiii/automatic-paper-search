// TS port of the manifest-dedup half of worker/themes-post.js
// (alreadyGenerated). H-1 contract preserved verbatim: a thrown fetch, a
// non-ok response, a JSON-parse error, or valid-but-non-array JSON must
// never be treated as "the theme already exists".

import { LAYOUT_MODE, type LayoutMode, relLayout } from "@paperpilot/core/layout";

/**
 * Repo-relative path of the published themes manifest that the theme
 * generators commit to `GH_REF`. Derived from the data layout so the
 * Worker follows the P5 data move (`docs/` -> `data/published/`) in the
 * same commit that moves the file; a hard-coded `docs/...` would 404
 * after the move and fail every request closed (503).
 */
export function themesManifestPath(mode: LayoutMode = LAYOUT_MODE): string {
  return `${relLayout(mode).published}/themes/themes-manifest.json`;
}

export interface ManifestEnv {
  GH_OWNER: string;
  GH_REPO: string;
  GH_REF: string;
}

export type ManifestResult = { ok: false } | { ok: true; exists: boolean };

export async function alreadyGenerated(
  slug: string,
  env: ManifestEnv,
  fetchImpl: typeof fetch,
): Promise<ManifestResult> {
  const manifestUrl = `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/${env.GH_REF}/${themesManifestPath()}`;
  let resp: Response;
  try {
    // L-7: never silently follow a redirect away from the pinned ref/path.
    resp = await fetchImpl(manifestUrl, { redirect: "manual" });
  } catch {
    return { ok: false };
  }
  if (!resp.ok) return { ok: false };
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(data)) return { ok: false };
  return { ok: true, exists: data.some((e) => (e as { slug?: unknown })?.slug === slug) };
}
