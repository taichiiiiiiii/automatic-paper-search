/**
 * "誤りを報告" link for one lineage relation (design doc 48 P0-2).
 *
 * Opens the GitHub issue form `.github/ISSUE_TEMPLATE/lineage-feedback.yml`
 * with its fields prefilled through query parameters (GitHub issue forms
 * accept `?<field id>=<value>`). The field ids below must match the form;
 * test/themes/feedback.test.ts checks that. Nothing is sent anywhere until
 * the reader submits the issue themselves.
 */

import { ISSUES_URL } from "../site-links";
import { edgeMethodLabelJa } from "./evidence";
import { relationLabelFor } from "./relations";

export const LINEAGE_FEEDBACK_TEMPLATE = "lineage-feedback.yml";
export const LINEAGE_FEEDBACK_LABEL = "lineage-feedback";
export const LINEAGE_FEEDBACK_FIELDS = [
  "theme",
  "relation",
  "older",
  "newer",
  "method",
  "page",
] as const;

/** Each prefilled value is clipped so the URL stays well under GitHub's
 * ~8 KB limit even for long titles. */
const MAX_FIELD = 400;
const MAX_TITLE = 120;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface FeedbackPaper {
  id: string;
  title?: string | null;
  year?: number | null;
}

export interface FeedbackEdge {
  src: string;
  dst: string;
  relation: string;
  confidence: number;
  rationale?: string | null;
  provenance?: { classification?: { method?: string | null } | null } | null;
}

function paperLine(p: FeedbackPaper): string {
  const year = typeof p.year === "number" ? ` (${p.year})` : "";
  return clip(`${p.id} — ${p.title || "(題名なし)"}${year}`, MAX_FIELD);
}

export function lineageFeedbackIssueUrl(args: {
  theme: { name: string; slug: string };
  edge: FeedbackEdge;
  older: FeedbackPaper;
  newer: FeedbackPaper;
  /** Absolute URL of the page (theme + `node=` of the newer paper). */
  pageUrl?: string | null;
  /** Audited collection (plain labels); otherwise strong ones are 候補. */
  audited?: boolean;
}): string {
  const { theme, edge, older, newer } = args;
  const audited = args.audited ?? false;
  const relJa = relationLabelFor(edge.relation, audited, edge.relation);
  const plainJa = relationLabelFor(edge.relation, true, edge.relation);
  const candidate = relJa !== plainJa;
  const method = edgeMethodLabelJa(edge.provenance?.classification?.method ?? null, edge.rationale);
  const confidence = Number.isFinite(edge.confidence) ? edge.confidence.toFixed(2) : "—";
  const params = new URLSearchParams();
  params.set("template", LINEAGE_FEEDBACK_TEMPLATE);
  params.set("labels", LINEAGE_FEEDBACK_LABEL);
  params.set(
    "title",
    clip(
      `[系譜の誤り] ${theme.name}: ${older.title || older.id} → ${relJa} → ${newer.title || newer.id}`,
      MAX_TITLE,
    ),
  );
  params.set("theme", clip(`${theme.name} (${theme.slug})`, MAX_FIELD));
  params.set(
    "relation",
    `${plainJa}（${edge.relation}${candidate ? "、規則で推定した候補" : ""}）`,
  );
  params.set("older", paperLine(older));
  params.set("newer", paperLine(newer));
  params.set("method", clip(`${method}・確信度 ${confidence}`, MAX_FIELD));
  if (args.pageUrl && /^https?:\/\//.test(args.pageUrl)) {
    params.set("page", clip(args.pageUrl, MAX_FIELD));
  }
  return `${ISSUES_URL}/new?${params.toString()}`;
}
