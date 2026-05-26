// Pure-logic input validation for `POST /api/themes`. Extracted from
// `handlePost` in worker/index.ts so the parse + theme-pattern +
// slug-derivation chain can be exercised in unit tests without the
// rest of the request orchestration (KV reads, GitHub dispatch, etc).
//
// The contract:
//   - input: raw object (the parsed JSON body) and the themeSlug helper
//   - output: { ok: true, raw: string, slug: string }
//          or { ok: false, status: number, body: { ok:false, status:string, message:string } }
//
// The caller maps a non-ok result straight to a Response via the
// existing json() helper; the ok result feeds into the dedup → rate-
// limit → dispatch chain.

import { THEME_INPUT_PATTERN } from "./slug.js";

/**
 * @param {unknown} body                              - parsed JSON request body
 * @param {(raw: string) => string} themeSlug         - slug derivation function
 * @returns {
 *   { ok: true, raw: string, slug: string } |
 *   { ok: false, status: number, body: object }
 * }
 */
export function validatePostInput(body, themeSlug) {
  // Body must be a plain object with a `theme` string field. Anything
  // else — array, null, scalar, missing field — falls through to the
  // pattern check, which trims `""` and bounces.
  const rawInput = body && typeof body === "object" && typeof body.theme === "string"
    ? body.theme.trim()
    : "";
  if (!THEME_INPUT_PATTERN.test(rawInput)) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        status: "invalid",
        message: "theme must be 2-80 chars matching /^[A-Za-z0-9 _-]+$/",
      },
    };
  }
  let slug;
  try {
    slug = themeSlug(rawInput);
  } catch (e) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        status: "invalid",
        message: `slug derivation failed: ${e && e.message ? e.message : "unknown"}`,
      },
    };
  }
  return { ok: true, raw: rawInput, slug };
}
