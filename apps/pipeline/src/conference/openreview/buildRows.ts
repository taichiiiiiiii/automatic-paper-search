/**
 * OpenReview note -> catalog row mapping — TS port of
 * `paperpilot/scripts/collect_openreview.py::build_rows` (and its small
 * `_value` / `_decision` / `_venue_tier` helpers).
 */

import { venueTier } from "../../collect/signals/venue.js";
import type { ConferenceRow } from "../shared/csvColumns.js";
import { pyWhitespaceCollapse } from "../shared/pyText.js";
import type { OpenReviewNote } from "./fetchNotes.js";

export const OPENREVIEW_FORUM = "https://openreview.net/forum?id=";
export const OPENREVIEW_PDF = "https://openreview.net/pdf?id=";

// Venues spell the decision differently in the `venue` value: ICLR/NeurIPS use
// space-separated words ("ICLR 2026 Oral", "NeurIPS 2025 spotlight"), while
// ICML 2025 uses the compound token "spotlightposter" (a spotlight-tier
// poster). The compound alternative must precede the bare words so it is
// matched whole — mirrored here by listing it first in the alternation.
const DECISION_RE = /\b(oral|spotlightposter|spotlight|poster)\b/i;
const COMPOUND_DECISIONS: Readonly<Record<string, string>> = { spotlightposter: "Spotlight" };
const HIGHLIGHTED = new Set(["Oral", "Spotlight"]);

/**
 * Read an OpenReview API v2 content field (values are wrapped as `{value: ...}`).
 * An explicit `{"value": null}` (OpenReview's representation of a null
 * field) yields `defaultValue`, not `null`/`undefined`, so callers never
 * stringify a null into the CSV as the literal "None"/"null".
 */
export function value(content: unknown, key: string, defaultValue: unknown = ""): unknown {
  if (content === null || typeof content !== "object") return defaultValue;
  const node = (content as Record<string, unknown>)[key];
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    const v = (node as Record<string, unknown>).value;
    return v === null || v === undefined ? defaultValue : v;
  }
  return node === null || node === undefined ? defaultValue : node;
}

/**
 * Parse the decision (Oral / Spotlight / Poster) from a `venue` label, e.g.
 * "ICLR 2025 Oral" -> "Oral", "ICML 2025 spotlightposter" -> "Spotlight".
 * Returns `""` when no recognised tier word is present (e.g. a bare
 * "Accept"), treated as non-highlighted.
 */
export function decision(venueLabel: string): string {
  const m = DECISION_RE.exec(venueLabel || "");
  const matched = m?.[1];
  if (!matched) return "";
  const raw = matched.toLowerCase();
  return COMPOUND_DECISIONS[raw] ?? raw[0]!.toUpperCase() + raw.slice(1);
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") return [v]; // malformed note: a bare string, not a list
  return [];
}

/**
 * Map OpenReview notes to catalog rows + the highlighted (Oral/Spotlight)
 * titles. Dedups by note id. Drops notes without a title/id and any stray
 * note whose venueid does not match (rejected / withdrawn submissions
 * carry a different venueid even though the query filters on the accepted
 * one).
 */
export function buildRows(
  notes: readonly OpenReviewNote[],
  venue: string,
  venueid: string,
): { rows: ConferenceRow[]; highlighted: string[] } {
  const targetTier = venueTier(venue);
  const venueToken = venue.toUpperCase();
  const papers = new Map<string, ConferenceRow>();
  const highlighted: string[] = [];

  for (const n of notes) {
    const nid = typeof n.id === "string" ? n.id : "";
    const content = n.content ?? {};
    const noteVenueid = String(value(content, "venueid", ""));
    if (noteVenueid && noteVenueid !== venueid) continue;
    const title = pyWhitespaceCollapse(String(value(content, "title", "")));
    if (!nid || !title || papers.has(nid)) continue;
    const rawAuthors = asStringList(value(content, "authors", []));
    const authors = rawAuthors.join("; ");
    const label = String(value(content, "venue", ""));
    papers.set(nid, {
      title,
      authors,
      venue: venueToken,
      venue_tier: targetTier,
      citation_count: 0,
      github_stars: 0,
      arxiv_id: "",
      abstract: pyWhitespaceCollapse(String(value(content, "abstract", ""))),
      url: `${OPENREVIEW_FORUM}${nid}`,
      pdf_url: `${OPENREVIEW_PDF}${nid}`,
      comment: label, // official decision label, retained verbatim
    });
    if (HIGHLIGHTED.has(decision(label))) highlighted.push(title);
  }

  return { rows: [...papers.values()], highlighted };
}
