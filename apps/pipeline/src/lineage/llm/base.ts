/**
 * LLM provider shared logic — TS port of `paperpilot/llm/base.py`.
 *
 * Covers: `PaperEvaluation.from_dict` (LLM-28..30), `map_batch_evaluations`
 * (LLM-31..34, closes #391), the Stage 4 evaluation prompt (LLM-44, LLM-45),
 * `RelationClassification.from_dict` (LLM-35..40), `TEMPLATE_RATIONALES` /
 * `_GENERIC_TEMPLATE_RATIONALES` (LLM-38, #131/#145), `CLASSIFY_SYSTEM_PROMPT`
 * verbatim (LLM-41..44), `safe_json_response` (LLM-22), and
 * `provider_model_tag` (LLM-46).
 *
 * `PaperEvaluation`/`RelationClassification`/`LLMProvider` TYPES live in
 * `collect/llm/provider.ts` (the shared, stable interface every concrete
 * provider implements) — this module only supplies the validation/parsing
 * FUNCTIONS over those shapes, so `lineage/**` never has to be imported
 * from `collect/**` (no cycle).
 */

import type {
  ClassifyPaperLike,
  LLMProvider,
  PaperEvaluation,
  Relation,
  RelationClassification,
} from "../../collect/llm/provider.js";
import { truthy } from "../../collect/pyish.js";

// ---------------------------------------------------------------------------
// Python-parity string helpers
// ---------------------------------------------------------------------------

/**
 * Python's `len()`/slicing on `str` count/index by Unicode CODE POINT, not
 * UTF-16 code unit — `s.length`/`s.slice()` would silently diverge for any
 * character outside the Basic Multilingual Plane (rare emoji, some CJK
 * extension ideographs). Every `_MAX_*`/`_MIN_*` length check this module
 * ports uses these, not the native string ops.
 */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

export function codePointSlice(s: string, end: number): string {
  return Array.from(s).slice(0, end).join("");
}

/** `str(x or "")` — Python's idiom for "blank text when `x` is falsy". */
function strOrEmpty(x: unknown): string {
  return truthy(x) ? String(x) : "";
}

/**
 * `int(x)` guarded by `except (TypeError, ValueError, OverflowError)`.
 * `bool` is an `int` subclass in Python, so `int(True) == 1` — NOT excluded
 * here (unlike the strict index check in {@link mapBatchEvaluations}, this
 * mirrors `PaperEvaluation.from_dict`'s plain `int(rel)` call, which has no
 * such guard). `±Infinity`/`NaN` degrade to `null` (OverflowError/ValueError)
 * rather than raising, per #391's follow-up fix.
 */
function pyIntCoerce(x: unknown): number | null {
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number") {
    if (Number.isNaN(x) || !Number.isFinite(x)) return null;
    return Math.trunc(x);
  }
  if (typeof x === "string") {
    const m = /^\s*[+-]?\d+\s*$/.exec(x);
    return m ? Number.parseInt(x.trim(), 10) : null;
  }
  return null;
}

/**
 * `float(x)` guarded by `except (TypeError, ValueError)`, with the caller's
 * default (`0.7` for confidence) substituted on failure. `float(bool)` is
 * valid in Python (`float(True) == 1.0`), so booleans coerce rather than
 * fail. Does not replicate Python's full float grammar (`"1_000.0"`,
 * hex floats) — not reachable from JSON-parsed LLM output.
 */
function pyFloatCoerce(x: unknown, fallback: number): number {
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const s = x.trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
    if (/^[+-]?inf(inity)?$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
    if (/^nan$/i.test(s)) return Number.NaN;
    return fallback;
  }
  return fallback;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Python's 2-arg `min`/`max`: keep the first argument unless the second
 * one is strictly less/greater (via `<`/`>`). `NaN` compared with `<`/`>`
 * is always `false` in both languages, so — UNLIKE JS's `Math.min`/
 * `Math.max`, which always propagate a `NaN` argument to the result
 * regardless of position — `pyMin2(1, NaN)` keeps `1` (the first arg is
 * unchanged because `NaN < 1` is `false`), matching CPython exactly.
 */
function pyMin2(a: number, b: number): number {
  return b < a ? b : a;
}
function pyMax2(a: number, b: number): number {
  return b > a ? b : a;
}

// ---------------------------------------------------------------------------
// PaperEvaluation.from_dict (LLM-28..30)
// ---------------------------------------------------------------------------

// Bound LLM output strings so a runaway model can't bloat CSV / log files.
const MAX_SUMMARY_LEN = 500;
const MAX_REASON_LEN = 200;
const MAX_TAG_LEN = 32;
const MAX_TAG_COUNT = 6;

/** TS port of `PaperEvaluation.from_dict`. `d` is the raw parsed-JSON element the LLM returned (snake_case keys, per the prompt contract). */
export function paperEvaluationFromDict(d: unknown): PaperEvaluation | null {
  if (!isPlainObject(d)) return null;
  const rawRel = d.relevance;
  let relInt: number | null;
  if (rawRel === null || rawRel === undefined) {
    relInt = null;
  } else {
    relInt = pyIntCoerce(rawRel);
  }
  if (relInt === null || relInt < 1 || relInt > 5) return null;

  const summaryJa = codePointSlice(strOrEmpty(d.summary_ja).trim(), MAX_SUMMARY_LEN);
  const reason = codePointSlice(strOrEmpty(d.reason).trim(), MAX_REASON_LEN);
  const tagsRaw = truthy(d.tags) ? d.tags : [];
  let tags: string[] = [];
  if (Array.isArray(tagsRaw)) {
    tags = tagsRaw
      .slice(0, MAX_TAG_COUNT)
      .filter((t) => truthy(t))
      .map((t) => codePointSlice(String(t).trim(), MAX_TAG_LEN));
  }
  return { relevance: relInt, summaryJa, reason, tags };
}

// ---------------------------------------------------------------------------
// map_batch_evaluations (closes #391) — LLM-31..34
// ---------------------------------------------------------------------------

/**
 * Map a parsed LLM batch response back to `papers`, one result each, by the
 * explicit 1-based `"index"` field (never by array position — a short,
 * reordered, gapped, or duplicated response must not silently misattribute
 * one paper's evaluation to another, closes #391). TS port of
 * `map_batch_evaluations`.
 */
export function mapBatchEvaluations(
  papersLength: number,
  parsed: unknown,
): (PaperEvaluation | null)[] {
  if (!Array.isArray(parsed)) return new Array(papersLength).fill(null);

  // Strict type check (not `Number(rawIndex)`): excludes `boolean` (typeof
  // guard alone handles it — unlike Python, JS booleans are not `typeof
  // "number"`), non-integer numbers, and numeric strings, all of which a
  // coercing cast would silently accept as a plausible-looking valid index.
  // NOTE (documented language gap): JSON `1.0` parses to the JS number `1`,
  // indistinguishable from the int `1` — Python's `type(1.0) is not int`
  // would reject it, so a response with a literal `1.0` index is accepted
  // here but rejected there. Unfixable without a source-level float marker.
  const validIndex = (item: unknown): number | null => {
    if (!isPlainObject(item)) return null;
    const raw = item.index;
    if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
    if (raw < 1 || raw > papersLength) return null;
    return raw;
  };

  // First pass: count how many elements claim each valid index. A count of
  // 2+ means the claim is ambiguous and must be rejected outright in the
  // second pass, regardless of either element's own field validity.
  const indexCounts = new Map<number, number>();
  for (const item of parsed) {
    const idx = validIndex(item);
    if (idx !== null) indexCounts.set(idx, (indexCounts.get(idx) ?? 0) + 1);
  }

  const byIndex = new Map<number, PaperEvaluation>();
  for (const item of parsed) {
    const idx = validIndex(item);
    if (idx === null || indexCounts.get(idx) !== 1) continue;
    const evaluation = paperEvaluationFromDict(item);
    if (evaluation !== null) byIndex.set(idx, evaluation);
  }

  const out: (PaperEvaluation | null)[] = [];
  for (let i = 1; i <= papersLength; i++) out.push(byIndex.get(i) ?? null);
  return out;
}

// ---------------------------------------------------------------------------
// Stage 4 evaluation prompt (LLM-44, LLM-45)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `\
あなたは学術論文の評価アシスタントです。
ユーザーの研究プロファイルに基づき、各論文の有用性を判定してください。

## 出力形式（厳守）
- JSON配列のみを返してください
- マークダウンのバッククォート（\`\`\`）は絶対に含めないでください
- 各要素: {"index": int, "relevance": 1-5, "summary_ja": str, "reason": str, "tags": [str]}
- index: 評価対象の論文リストで示された番号（[論文1]なら1、[論文2]なら2、...）をそのまま設定してください
- relevance: 1=無関係, 2=弱い関連, 3=中程度, 4=強い関連, 5=必読
- summary_ja: 日本語で3行以内の要約
- reason: 日本語で1文、読むべき理由（無関係なら読まなくてよい理由）
- tags: 最大4個の日本語タグ（例: 「新手法」「ベンチマーク」「応用」「理論」）
- 全ての論文について1件ずつ評価を返してください（省略・重複禁止）
`;

const USER_TEMPLATE_HEADER = "## あなたの研究プロファイル\n";

/** Minimal shape {@link buildEvaluationPrompt} reads off a `Paper` — kept loose so callers don't have to construct a full `Paper`. */
export interface EvaluationPromptPaper {
  title: string;
  abstract: string | null;
  categories: readonly string[];
  venue: string | null;
  githubStars: number;
  citationCount: number;
}

const EVALUATION_ABSTRACT_TRIM = 500;

/** TS port of `build_evaluation_prompt`. Returns `[system, user]`. */
export function buildEvaluationPrompt(
  papers: readonly EvaluationPromptPaper[],
  profile: string,
): [string, string] {
  const blocks: string[] = [];
  papers.forEach((p, i) => {
    const n = i + 1;
    const abstract = codePointSlice(p.abstract ?? "", EVALUATION_ABSTRACT_TRIM);
    const categories = p.categories.length > 0 ? p.categories.join(", ") : "-";
    const venue = p.venue || "未査読";
    blocks.push(
      `[論文${n}]\n` +
        `タイトル: ${p.title}\n` +
        `カテゴリ: ${categories}\n` +
        `学会: ${venue}\n` +
        `GitHub Stars: ${p.githubStars}\n` +
        `引用数: ${p.citationCount}\n` +
        `アブストラクト: ${abstract}`,
    );
  });
  const profileText = profile.trim() || "(プロファイル未設定: キーワード一致のみで判断)";
  const user =
    `${USER_TEMPLATE_HEADER}${profileText}\n\n` +
    `## 評価対象の論文（${papers.length}件）\n${blocks.join("\n\n")}\n\n` +
    `各論文について、その番号を"index"に設定したJSON配列で評価してください。\n`;
  return [SYSTEM_PROMPT, user];
}

// ---------------------------------------------------------------------------
// Lineage relation classification (LLM-35..44)
// ---------------------------------------------------------------------------

export const VALID_RELATIONS: ReadonlySet<Relation> = new Set([
  "supersedes",
  "successor",
  "extends",
  "ablation",
  "baseline_only",
  "contrasts",
  "unrelated",
]);

const MAX_RATIONALE_LEN = 280;
// Minimum rationale length (#297). A real rationale is a Japanese sentence
// of >=30 chars per CLASSIFY_SYSTEM_PROMPT's "30-200 chars" rule; 10 is a
// conservative "clearly degenerate" floor that catches the truncated LLM
// outputs seen in production ("A" / "QD" / "VLM" / "VLLM" / "CMA-ES" /
// "Qwen2-VL" / "P-GenRM") without over-rejecting borderline-valid short
// outputs.
export const MIN_RATIONALE_LEN = 10;
const CLASSIFY_ABSTRACT_TRIM = 600;

/**
 * Single source of truth for heuristic template rationales (#145 followup).
 * TS port of `base.py`'s `TEMPLATE_RATIONALES`. Three consumers
 * cross-reference these strings and MUST stay in perfect byte-for-byte
 * sync: (1) `lineage/classify`'s `_INTENT_RELATION_MAP` emits them as
 * heuristic edges, (2) `GENERIC_TEMPLATE_RATIONALES` below (reject set
 * used by {@link relationClassificationFromDict} to catch LLM template
 * echoes, #131 second-line defence), (3) `CLASSIFY_SYSTEM_PROMPT` lists 3
 * of these as forbidden outputs in plain text.
 */
export const TEMPLATE_RATIONALES: Readonly<Record<string, string>> = {
  extends_methodology: "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している。",
  successor_result: "論文 B は論文 A の研究ラインを継承し自然に発展させている。",
  baseline_only_background: "論文 B は論文 A をベースライン比較にのみ用いている。",
  contrasts_year_cite: "論文 B は論文 A と根本的に異なるアプローチを提案している。",
  supersedes_year_cite: "論文 B は論文 A の手法を置き換える改良版として提案されている。",
  ablation_year_cite: "論文 B は論文 A の構成要素を分析・ablation している。",
};

/**
 * Reject set for LLM template echoes (#131). Derived from
 * {@link TEMPLATE_RATIONALES} so the two can't drift.
 */
export const GENERIC_TEMPLATE_RATIONALES: ReadonlySet<string> = new Set(
  Object.values(TEMPLATE_RATIONALES),
);

/** TS port of `RelationClassification.from_dict`. */
export function relationClassificationFromDict(d: unknown): RelationClassification | null {
  if (!isPlainObject(d)) return null;
  const rel = d.relation;
  if (typeof rel !== "string" || !VALID_RELATIONS.has(rel as Relation)) return null;
  const rationale = codePointSlice(strOrEmpty(d.rationale).trim(), MAX_RATIONALE_LEN);
  if (!rationale) return null;
  if (codePointLength(rationale) < MIN_RATIONALE_LEN) return null;
  if (GENERIC_TEMPLATE_RATIONALES.has(rationale)) return null;
  const rawConfidence = "confidence" in d ? d.confidence : 0.7;
  let confidence = pyFloatCoerce(rawConfidence, 0.7);
  // H1 (#review): `Math.max(0, Math.min(1, NaN))` is NaN in JS (NaN
  // poisons both calls regardless of argument order) — Python's
  // `max(0.0, min(1.0, float("nan")))` is 1.0 (verified against CPython:
  // nan/inf/-inf/"nan" all clamp the same way the two-arg min/max
  // comparisons below reproduce). A bare NaN written to the classification
  // cache JSON is unparseable by `JSON.parse` on the next read (H1), so
  // clamping here is also what keeps every classification this port
  // writes JSON-round-trippable.
  confidence = pyMax2(0, pyMin2(1, confidence));
  return { relation: rel as Relation, confidence, rationale };
}

// Production traces showed Llama 3.3 70B would translate the prompt's
// English enum definitions into Japanese rather than reading the
// abstracts, producing byte-for-byte heuristic templates. This prompt (a)
// shortens the enum text so it can't be translated wholesale, (b)
// explicitly forbids the template phrasings as outputs, (c) shows one good
// example anchoring paper-specific style. Token budget kept under ~330
// tokens (1,191 chars, test-pinned at <=1200) because Groq's free tier caps
// at ~12,000 TPM. VERBATIM port of `llm/base.py::CLASSIFY_SYSTEM_PROMPT` —
// parity-tested byte-for-byte against the Python string.
export const CLASSIFY_SYSTEM_PROMPT = `Compare two AI/ML papers (A older, B newer). Output ONLY JSON:
{"relation":"<one>","confidence":<0.0-1.0>,"rationale":"<one Japanese sentence>"}

relation values (pick one): supersedes / successor / extends / ablation / baseline_only / contrasts / unrelated
- supersedes: 同じアプローチで明確に性能を凌駕、基準論文を置き換える
- successor: 研究ラインの自然な発展、漸進的な改良
- extends: 同じ手法を別ドメイン・別タスク・別規模に応用
- ablation: 構成要素の寄与を分解測定する解析論文
- baseline_only: 比較対象として引用するだけで、知的な継承はない
- contrasts: 同じ問題に対する根本的に異なるアプローチ

rationale rules — read carefully, most errors are here:
- 30-200 chars, one Japanese sentence
- MUST mention a concrete concept from B's title or abstract (a method name, dataset, metric, or architectural choice), so the reader knows which two papers are compared.
- NEVER output these heuristic templates (emitting them wastes an LLM call):
  - "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している"
  - "論文 B は論文 A の研究ラインを継承し自然に発展させている"
  - "論文 B は論文 A をベースライン比較にのみ用いている"

Examples (each names a concrete concept):
- extends: "B のグラフ畳み込み層は、A のスペクトル法を空間領域に再定式化し計算量を O(E) に落としている。"
- supersedes: "B (FlashAttention-2) は A と同じ exact attention のまま work partitioning を改良し2倍高速化、A を置き換える。"
- ablation: "B は A の各構成要素を取り除いて精度への寄与を分解測定している。"
`;

/** TS port of `build_classify_prompt`. `a` = older/target, `b` = newer/candidate. */
export function buildClassifyPrompt(a: ClassifyPaperLike, b: ClassifyPaperLike): [string, string] {
  // SECURITY (#300): only title/year/abstract are interpolated — NEVER a
  // prior `rationale` string (prompt-injection vector via a slot-filled
  // heuristic rationale that embeds an attacker-controlled title).
  const getOrDefault = (obj: ClassifyPaperLike, key: string, def: string): string => {
    if (!(key in obj)) return def;
    const v = obj[key];
    // Python's `.get(key, default)` only substitutes `default` when the key
    // is ABSENT; a key present with value `None` returns `None`, and the
    // f-string then renders it as the literal text "None" via `str(None)`.
    return v === null || v === undefined ? "None" : String(v);
  };
  const abstractField = (obj: ClassifyPaperLike, key: string): string => {
    const v = obj[key];
    const s = v === null || v === undefined || v === "" ? "" : String(v);
    return codePointSlice(s, CLASSIFY_ABSTRACT_TRIM);
  };
  const user =
    `PAPER A (older / target):\n` +
    `Title: ${getOrDefault(a, "title", "")}\n` +
    `Year: ${getOrDefault(a, "year", "?")}\n` +
    `Abstract: ${abstractField(a, "abstract")}\n\n` +
    `PAPER B (newer / candidate):\n` +
    `Title: ${getOrDefault(b, "title", "")}\n` +
    `Year: ${getOrDefault(b, "year", "?")}\n` +
    `Abstract: ${abstractField(b, "abstract")}\n\n` +
    `How does Paper B relate to Paper A?\n`;
  return [CLASSIFY_SYSTEM_PROMPT, user];
}

// ---------------------------------------------------------------------------
// safe_json_response (LLM-22)
// ---------------------------------------------------------------------------

/** Minimal shape of the TS HTTP response this module needs (see `collect/http/requestWithRetry.ts::HttpResponseLike`). */
export interface JsonResponseLike {
  json(): Promise<unknown>;
}

/**
 * TS port of `safe_json_response`. A 200 status only means the HTTP
 * transport succeeded — the body itself can still be an HTML error page, a
 * truncated stream, or valid JSON of the wrong shape. Returns the parsed
 * value only when it decodes AND is a plain object; `null` otherwise so
 * callers treat "200 but garbage/wrong-shape body" exactly like "non-200".
 */
export async function safeJsonResponse(
  resp: JsonResponseLike,
): Promise<Record<string, unknown> | null> {
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return null;
  }
  return isPlainObject(data) ? data : null;
}

// ---------------------------------------------------------------------------
// provider_model_tag (#310, LLM-46)
// ---------------------------------------------------------------------------

/**
 * Stable `'name:model'` tag for the LLM that produced a cached
 * classification, e.g. `'gemini:gemini-2.5-flash'`. Falls back to the bare
 * provider name when `.model` is absent.
 */
export function providerModelTag(provider: unknown): string {
  if (provider === null || typeof provider !== "object") return "unknown";
  const name = (provider as { name?: unknown }).name;
  const model = (provider as { model?: unknown }).model;
  const nameStr = typeof name === "string" ? name : "unknown";
  return typeof model === "string" && model ? `${nameStr}:${model}` : nameStr;
}

export type { LLMProvider };
