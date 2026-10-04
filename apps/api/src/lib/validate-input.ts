// TS port of worker/validate-input.js. Pure-logic input validation for
// `POST /api/themes`, kept independent of the rest of the request
// orchestration so it is unit-testable without KV/fetch stand-ins.

import { THEME_INPUT_PATTERN } from "./slug.js";

export type ValidatePostInputResult =
  | { ok: true; raw: string; slug: string }
  | { ok: false; status: number; body: { ok: false; status: "invalid"; message: string } };

export function validatePostInput(
  body: unknown,
  themeSlug: (raw: string) => string,
): ValidatePostInputResult {
  const rawInput =
    body && typeof body === "object" && typeof (body as { theme?: unknown }).theme === "string"
      ? (body as { theme: string }).theme.trim()
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
  let slug: string;
  try {
    slug = themeSlug(rawInput);
  } catch (e) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        status: "invalid",
        message: `slug derivation failed: ${e && (e as Error).message ? (e as Error).message : "unknown"}`,
      },
    };
  }
  return { ok: true, raw: rawInput, slug };
}
