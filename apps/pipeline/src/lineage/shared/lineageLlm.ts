/**
 * R2-24 (design 41): the switch between lineage generation with an LLM
 * and from API evidence only. One environment variable for every lineage
 * builder (theme / conference / deep):
 *
 *   PAPERPILOT_LINEAGE_LLM=off  -> no LLM: no provider is built (no key
 *                                  needed), relations come from Semantic
 *                                  Scholar citation contexts, reference
 *                                  lists, title versions and the allowlist;
 *   PAPERPILOT_LINEAGE_LLM=on   -> the LLM path as before.
 *
 * Unset = the caller's default: `off` for themes (since R2-24), `on` for
 * the conference / deep builders (unchanged until they are evaluated).
 */

/** Environment variable that switches the lineage builders' LLM use. */
export const LINEAGE_LLM_ENV = "PAPERPILOT_LINEAGE_LLM";

export type LineageLlmMode = "on" | "off";

/** Raised for a value other than on/off (a typo must not flip the mode). */
export class LineageLlmModeError extends Error {}

/** The flag wins, then the environment variable, then `fallback`. */
export function resolveLineageLlm(
  flag: LineageLlmMode | null,
  env: Readonly<Record<string, string | undefined>>,
  fallback: LineageLlmMode,
): LineageLlmMode {
  if (flag !== null) return flag;
  const raw = (env[LINEAGE_LLM_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (raw === "on" || raw === "off") return raw;
  throw new LineageLlmModeError(
    `${LINEAGE_LLM_ENV} must be "on" or "off", got ${JSON.stringify(raw)}`,
  );
}
