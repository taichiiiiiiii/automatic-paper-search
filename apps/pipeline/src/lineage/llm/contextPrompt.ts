/**
 * Citation-context relation prompt (design 41 D6, design 43 §8 "API 優先 +
 * LLM は補助"). The abstract prompt (`buildClassifyPrompt`,
 * relation-prompt-v2) shows the model two abstracts and lets it guess a
 * lineage; on the R2-9 hand check it called 19 of 24 "inherits" pairs
 * wrongly. This prompt instead shows the sentences in which the citing
 * paper B actually cites A (Semantic Scholar `contexts`) plus A's
 * bibliographic data, and asks two narrow questions:
 *   (a) is the cue in the sentence about A (sentences often cite several
 *       works at once), and
 *   (b) which of builds_on / compares_with / uses_resource / background.
 *
 * Only edges where rule set v2 found a cue phrase, or S2 marks the citation
 * influential with no cue, are sent here (`../theme/s2Relations.ts`).
 * The answer is mapped onto the v1 relation enum by the caller.
 */

import type { ClassifyPaperLike } from "../../collect/llm/provider.js";
import { shortPaperName } from "../classify/citedTarget.js";
import { codePointLength, codePointSlice, MIN_RATIONALE_LEN } from "./base.js";

/** Provenance `prompt_version` of context-prompt answers. R2-16 bumped
 * v3 -> v4 together with the abstract prompt (`relation-prompt-v4`):
 * rationales name the papers by short title instead of "A"/"B", both
 * papers' short names are in the user message, and only usable context
 * sentences are sent. The theme cache key hashes the exact prompt text and
 * carries this version, so v3 answers are never reused. */
export const CONTEXT_PROMPT_VERSION = "relation-prompt-v4-context";

/**
 * R2-20: SEMANTIC version of the context prompt — the cache key of an
 * answer (`cachedClassifyProvider.ts`, cache v4) hashes this plus the
 * pair's INPUT DATA ({@link contextPromptInputs}), not the prompt text, so
 * cached answers survive wording-only edits.
 *
 * Rule: bump this ONLY when the meaning of an answer changes — the
 * question asked, the label set or a label's definition, the answer
 * fields, or which input data the model sees (e.g. more context
 * sentences, a different truncation). Copy edits (rephrasing, typo
 * fixes, examples that do not change a label's scope, batch/single
 * framing) keep it; bump {@link CONTEXT_PROMPT_VERSION} (provenance)
 * instead when the published rationale style changes.
 */
export const CONTEXT_SEMANTIC_VERSION = "context-semantic-v1";

export const CONTEXT_RELATIONS = [
  "builds_on",
  "compares_with",
  "uses_resource",
  "background",
] as const;
export type ContextRelation = (typeof CONTEXT_RELATIONS)[number];

const MAX_CONTEXTS = 4;
const MAX_CONTEXT_CHARS = 400;
const MAX_AUTHORS = 3;
const MAX_RATIONALE = 200;

/** Instructions shared by the single and the batched prompt. */
const CONTEXT_INSTRUCTIONS = `A sentence often cites several works at once ("[3, 7, 12]"). First decide whether the cue words (build on, extend, inspired by, unlike, outperform, compared with, use the dataset/code, ...) are about paper A itself: refers_to_cited. Recognise A by its title, authors and year.

relation — what B does with A (answer background when refers_to_cited is false):
- builds_on: B's method is built on, extends, adapts or follows A's method
- compares_with: B compares its results with A, or positions its approach against A
- uses_resource: B uses A's dataset, benchmark, code, optimizer or pretrained weights without building on A's method
- background: A is only mentioned as related work or context
contrast: true only if B explicitly says its approach differs from A's on the same task ("unlike A", "in contrast to A").

rationale: 30-150 chars, one Japanese sentence naming A's concept and what B does with it. Call the papers by their short names (given below), never "A" or "B". Do not copy the English sentence.
`;

const ANSWER_FIELDS =
  '"refers_to_cited":<true|false>,"relation":"<one>","contrast":<true|false>,"confidence":<0.0-1.0>,"rationale":"<one Japanese sentence>"';

export const CONTEXT_SYSTEM_PROMPT = `You read the sentences in which paper B (newer) cites paper A (older). Output ONLY JSON:
{${ANSWER_FIELDS}}

${CONTEXT_INSTRUCTIONS}`;

/** R2-20: the same question for several pairs in one request. */
export const CONTEXT_BATCH_SYSTEM_PROMPT = `You get several PAIRS, each with an id. In each pair you read the sentences in which paper B (newer) cites paper A (older). Answer every pair independently. Output ONLY JSON, one answer per pair:
{"answers":[{"id":"<pair id>",${ANSWER_FIELDS}}, ...]}

${CONTEXT_INSTRUCTIONS}`;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function authorNames(paper: ClassifyPaperLike): string[] {
  const raw = paper.authors;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) =>
      typeof a === "string"
        ? a.trim()
        : a && typeof a === "object"
          ? str((a as { name?: unknown }).name)
          : "",
    )
    .filter(Boolean);
}

/**
 * The data the model sees about one pair (R2-20): everything the prompt
 * text is built from, and what the semantic cache key hashes. Changing
 * what goes in here changes the answer's meaning — bump
 * {@link CONTEXT_SEMANTIC_VERSION}.
 */
export interface ContextPromptInputs {
  cited: { title: string; short: string; authors: string; year: string };
  citing: { title: string; short: string; year: string };
  sentences: string[];
}

export function contextPromptInputs(
  cited: ClassifyPaperLike,
  citing: ClassifyPaperLike,
  contexts: readonly string[],
): ContextPromptInputs {
  const authors = authorNames(cited);
  const shown = authors.slice(0, MAX_AUTHORS).join(", ");
  const more = authors.length > MAX_AUTHORS ? " et al." : "";
  return {
    cited: {
      title: str(cited.title),
      short: shortPaperName(cited),
      authors: shown ? `${shown}${more}` : "?",
      year: typeof cited.year === "number" ? String(cited.year) : "?",
    },
    citing: {
      title: str(citing.title),
      short: shortPaperName(citing),
      year: typeof citing.year === "number" ? String(citing.year) : "?",
    },
    sentences: contexts
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, MAX_CONTEXTS)
      .map((c) => codePointSlice(c, MAX_CONTEXT_CHARS)),
  };
}

function pairBlock(inp: ContextPromptInputs): string {
  return (
    `PAPER A (older, cited):\n` +
    `Title: ${inp.cited.title}\n` +
    `Short name: ${inp.cited.short}\n` +
    `Authors: ${inp.cited.authors}\n` +
    `Year: ${inp.cited.year}\n\n` +
    `PAPER B (newer, citing):\nTitle: ${inp.citing.title}\n` +
    `Short name: ${inp.citing.short}\n` +
    `Year: ${inp.citing.year}\n\n` +
    `Sentences in B that cite A:\n${inp.sentences.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`
  );
}

/** `cited` = A (older), `citing` = B (newer), `contexts` = B's sentences
 * citing A (Semantic Scholar). Returns `[system, user]`. */
export function buildContextPrompt(
  cited: ClassifyPaperLike,
  citing: ClassifyPaperLike,
  contexts: readonly string[],
): [string, string] {
  const user = `${pairBlock(contextPromptInputs(cited, citing, contexts))}\nIs the cue about A, and what does B do with A?\n`;
  return [CONTEXT_SYSTEM_PROMPT, user];
}

/** R2-20: one request for several pairs; `id`s must be unique (e.g. `p1`). */
export function buildContextBatchPrompt(
  pairs: readonly { id: string; inputs: ContextPromptInputs }[],
): [string, string] {
  const blocks = pairs.map((p) => `=== PAIR ${p.id} ===\n${pairBlock(p.inputs)}`);
  const user =
    `${blocks.join("\n")}\n` +
    `For every pair (${pairs.map((p) => p.id).join(", ")}): is the cue about A, and what does B do with A?\n`;
  return [CONTEXT_BATCH_SYSTEM_PROMPT, user];
}

export interface ContextAnswer {
  refers_to_cited: boolean;
  relation: ContextRelation;
  contrast: boolean;
  confidence: number;
  rationale: string;
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

/** Validate one parsed answer (or a cached one); `null` when unusable. */
export function parseContextAnswer(raw: unknown): ContextAnswer | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const refers = bool(d.refers_to_cited);
  if (refers === null) return null;
  const rel = d.relation;
  if (typeof rel !== "string" || !(CONTEXT_RELATIONS as readonly string[]).includes(rel)) {
    return null;
  }
  const rationale = codePointSlice(str(d.rationale), MAX_RATIONALE);
  if (codePointLength(rationale) < MIN_RATIONALE_LEN) return null;
  let confidence = typeof d.confidence === "number" ? d.confidence : Number(d.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.7;
  confidence = Math.min(1, Math.max(0, confidence));
  return {
    refers_to_cited: refers,
    // A cue that is about another work says nothing about A.
    relation: refers ? (rel as ContextRelation) : "background",
    contrast: refers && bool(d.contrast) === true,
    confidence,
    rationale,
  };
}

/** Parse a raw model response (JSON object, possibly wrapped in prose). */
export function parseContextResponse(text: string | null): ContextAnswer | null {
  if (text === null) return null;
  const trimmed = text.trim();
  const candidates = [trimmed];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = parseContextAnswer(JSON.parse(c));
      if (parsed !== null) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * R2-20: parse a batched answer `{"answers":[{"id":…, …}, …]}` into one
 * validated answer per requested id. Returns `null` when the response is
 * not that shape at all (the caller then asks each pair singly); ids with
 * a missing, duplicated or invalid answer are simply absent from the map.
 */
export function parseContextBatchResponse(
  text: string | null,
  ids: readonly string[],
): Map<string, ContextAnswer> | null {
  if (text === null) return null;
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (!(first >= 0 && last > first)) return null;
    try {
      parsed = JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  const list =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { answers?: unknown }).answers
      : Array.isArray(parsed)
        ? parsed
        : undefined;
  if (!Array.isArray(list)) return null;
  const wanted = new Set(ids);
  const seen = new Map<string, number>();
  const out = new Map<string, ContextAnswer>();
  for (const item of list) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const id = (item as { id?: unknown }).id;
    const key = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
    if (!wanted.has(key)) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const answer = parseContextAnswer(item);
    if (answer !== null) out.set(key, answer);
  }
  // Two answers for one id: trust neither.
  for (const [id, n] of seen) if (n > 1) out.delete(id);
  return out;
}
