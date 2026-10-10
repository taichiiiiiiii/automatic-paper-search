/**
 * Human audit drafts for a theme lineage (design doc 41 D5, R2-8).
 *
 * The audit covers every node (on-topic? metadata correct?) and every
 * strong-claim relation (the policy's `strong_relations`, default
 * contrasts/supersedes/extends/successor). The flow is:
 *
 * 1. `buildAuditDraft` turns a committed `lineage.json` into a pending
 *    draft (`lineage-audit-draft-v1`): every verdict field is `null`, and
 *    each item carries the display data the auditor needs plus an optional
 *    `suggestion` (a second reviewer's preliminary call, never a verdict).
 * 2. `renderAuditSheet` renders the draft as a Japanese Markdown sheet.
 * 3. The auditor edits the draft JSON (verdicts, `auditor`, `audited_at`).
 * 4. `importAuditDraft` checks the edited draft against the current
 *    artifact bytes and turns it into one `lineage-audit-fixtures-v1`
 *    entry (`reviewer` = auditor, `reviewed_at` = audited_at).
 *
 * Suggestions only become verdicts when the auditor sets
 * `accept_suggestions_for_unset: true` in the draft themselves.
 */

import { createHash } from "node:crypto";
import { isSurveyLike } from "../shared/surveyLike.js";
import { DEFAULT_STRONG_RELATIONS, SAMPLE_LIMIT } from "./buildLineageQuality.js";

export const AUDIT_DRAFT_SCHEMA_VERSION = "lineage-audit-draft-v1";

export type Assessment = "looks_right" | "doubtful";

export interface NodeSuggestion {
  on_topic: boolean | null;
  metadata_ok: boolean | null;
  assessment: Assessment | null;
  reason: string;
}

export interface RelationSuggestion {
  verdict: "correct" | "wrong" | null;
  corrected_relation: string | null;
  assessment: Assessment | null;
  reason: string;
}

export interface DraftNode {
  node_id: string;
  title: string;
  year: number | null;
  venue: string | null;
  authors: string[];
  doi: string | null;
  arxiv_id: string | null;
  links: Record<string, string>;
  citation_count: number | null;
  is_focus: boolean;
  is_root: boolean;
  survey_like: boolean;
  degree: number;
  why_included: string;
  /** Human verdicts — `null` until the auditor fills them. */
  on_topic: boolean | null;
  metadata_ok: boolean | null;
  note: string;
  suggestion: NodeSuggestion;
}

export interface DraftRelation {
  src: string;
  dst: string;
  relation: string;
  src_title: string;
  src_year: number | null;
  dst_title: string;
  dst_year: number | null;
  confidence: number | null;
  method: string | null;
  model: string | null;
  rationale: string;
  quote: string | null;
  flags: string[];
  /** Human verdict — `null` until the auditor fills it. */
  verdict: "correct" | "wrong" | null;
  corrected_relation: string | null;
  note: string;
  suggestion: RelationSuggestion;
}

export interface AuditDraft {
  schema_version: typeof AUDIT_DRAFT_SCHEMA_VERSION;
  collection_id: string;
  theme: string;
  lineage_path: string;
  input_sha256: string;
  generated_at: string;
  strong_relations: string[];
  instructions: string[];
  auditor: string;
  audited_at: string;
  accept_suggestions_for_unset: boolean;
  nodes: DraftNode[];
  relations: DraftRelation[];
}

export const RELATION_MEANING_JA: Readonly<Record<string, string>> = {
  extends: "引用側（新しい論文）が被引用側の手法を土台にして拡張している",
  successor: "引用側が被引用側の直接の後継（同じ系列の次の段階）である",
  supersedes: "引用側が被引用側を置き換える新版（同じ系列の改訂版）である",
  contrasts: "引用側が被引用側との違いをはっきり示し、対照的な手法を取っている",
  ablation: "引用側が被引用側の要素を外して効果を確かめている",
  baseline_only: "比較対象・背景として引用しているだけ",
};

const RELATION_CHOICES = Object.keys(RELATION_MEANING_JA);

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function shortTitle(title: string): string {
  const head = title.split(":")[0]!.trim();
  return head.length <= 40 ? head : `${head.slice(0, 39)}…`;
}

function nodeLinks(id: string, doi: string | null, arxivId: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  const openalex = /^openalex:(W\d+)$/.exec(id);
  if (openalex) links.openalex = `https://openalex.org/${openalex[1]}`;
  if (doi) links.doi = `https://doi.org/${doi.replace(/^https?:\/\/doi\.org\//, "")}`;
  if (arxivId) {
    links.arxiv = `https://arxiv.org/abs/${arxivId}`;
    links.semantic_scholar = `https://www.semanticscholar.org/arxiv/${arxivId}`;
  } else if (doi) {
    links.semantic_scholar = `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=title,year,authors,externalIds`;
  }
  return links;
}

/** Pulls the first quoted citation sentence (`引用文: "…"`) out of a rationale. */
export function quoteFromRationale(rationale: string): string | null {
  const m =
    /引用文:\s*"([\s\S]*?)"\s*$/.exec(rationale) ?? /引用文:\s*"([\s\S]*?)"/.exec(rationale);
  return m ? m[1]!.trim() : null;
}

function relationOf(edge: Record<string, unknown>): string | null {
  return str(edge.relation) ?? str(edge.rel);
}

function sortKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface BuildAuditDraftOptions {
  lineage: unknown;
  lineageBytes: Buffer;
  collectionId: string;
  lineagePath: string;
  generatedAt: string;
  strongRelations?: readonly string[];
}

/** Builds a pending draft. Throws on an artifact without nodes/edges. */
export function buildAuditDraft(options: BuildAuditDraftOptions): AuditDraft {
  const { lineage, lineageBytes, collectionId, lineagePath, generatedAt } = options;
  const strong = [...(options.strongRelations ?? DEFAULT_STRONG_RELATIONS)];
  if (!isMapping(lineage) || !Array.isArray(lineage.nodes) || !Array.isArray(lineage.edges)) {
    throw new Error("lineage artifact has no nodes/edges arrays");
  }
  const meta = isMapping(lineage.meta) ? lineage.meta : {};
  const root = str(lineage.root);
  const seeds = new Set(
    Array.isArray(meta.seeds) ? meta.seeds.filter((s) => typeof s === "string") : [],
  );
  const canonical = new Set(
    Array.isArray(meta.canonical_seeds)
      ? meta.canonical_seeds.filter((s) => typeof s === "string")
      : [],
  );
  const gate = isMapping(meta.topic_gate) ? str(meta.topic_gate.method) : null;

  const nodeById = new Map<string, Record<string, unknown>>();
  for (const node of lineage.nodes) {
    if (isMapping(node) && str(node.id)) nodeById.set(node.id as string, node);
  }
  const titleOf = (id: string) => str(nodeById.get(id)?.title) ?? id;
  const yearOf = (id: string) => num(nodeById.get(id)?.year);

  const neighbours = new Map<string, { cites: Set<string>; citedBy: Set<string> }>();
  const touch = (id: string) => {
    let entry = neighbours.get(id);
    if (!entry) {
      entry = { cites: new Set(), citedBy: new Set() };
      neighbours.set(id, entry);
    }
    return entry;
  };
  const edges = lineage.edges.filter(isMapping);
  for (const edge of edges) {
    const src = str(edge.src);
    const dst = str(edge.dst);
    if (!src || !dst) continue;
    // src = cited (older), dst = citing.
    touch(dst).cites.add(src);
    touch(src).citedBy.add(dst);
  }

  const nodes: DraftNode[] = [];
  for (const [id, node] of nodeById) {
    const doi = str(node.doi);
    const arxivId = str(node.arxiv_id);
    const nb = neighbours.get(id) ?? { cites: new Set<string>(), citedBy: new Set<string>() };
    const degree = new Set([...nb.cites, ...nb.citedBy]).size;
    const reasons: string[] = [];
    if (id === root) reasons.push("根（次数が最大のフォーカス論文）");
    if (node.is_focus === true) reasons.push("フォーカス論文（テーマ検索で選ばれたシード）");
    else if (seeds.has(id)) reasons.push("シード");
    if (canonical.has(id)) reasons.push("正典シード（meta.canonical_seeds）");
    const linkNames = (ids: Set<string>) =>
      [...ids]
        .sort(sortKey)
        .slice(0, 3)
        .map((n) => `「${shortTitle(titleOf(n))}」`)
        .join("・");
    if (nb.citedBy.size > 0) {
      reasons.push(`グラフ内の ${nb.citedBy.size} 本に引用される（${linkNames(nb.citedBy)} など）`);
    }
    if (nb.cites.size > 0) {
      reasons.push(`グラフ内の ${nb.cites.size} 本を引用する（${linkNames(nb.cites)} など）`);
    }
    if (node.is_focus !== true && !seeds.has(id) && gate) {
      reasons.push(`テーマ判定（${gate}）を通過`);
    }
    nodes.push({
      node_id: id,
      title: str(node.title) ?? id,
      year: num(node.year),
      venue: str(node.venue),
      authors: Array.isArray(node.authors)
        ? node.authors.filter((a): a is string => typeof a === "string")
        : [],
      doi,
      arxiv_id: arxivId,
      links: nodeLinks(id, doi, arxivId),
      citation_count: num(node.citation_count),
      is_focus: node.is_focus === true,
      is_root: id === root,
      survey_like: isSurveyLike(node as Parameters<typeof isSurveyLike>[0]),
      degree,
      why_included: reasons.join("。") || "理由の記録なし",
      on_topic: null,
      metadata_ok: null,
      note: "",
      suggestion: { on_topic: null, metadata_ok: null, assessment: null, reason: "" },
    });
  }
  nodes.sort(
    (a, b) =>
      Number(b.is_focus) - Number(a.is_focus) ||
      (a.year ?? 9999) - (b.year ?? 9999) ||
      sortKey(a.node_id, b.node_id),
  );

  const relations: DraftRelation[] = [];
  const pairKeys = new Set<string>();
  for (const edge of edges) {
    const src = str(edge.src);
    const dst = str(edge.dst);
    if (src && dst) pairKeys.add(`${src}->${dst}`);
  }
  for (const edge of edges) {
    const src = str(edge.src);
    const dst = str(edge.dst);
    const relation = relationOf(edge);
    if (!src || !dst || !relation || !strong.includes(relation)) continue;
    const rationale = str(edge.rationale) ?? "";
    const provenance = isMapping(edge.provenance) ? edge.provenance : {};
    const classification = isMapping(provenance.classification) ? provenance.classification : {};
    const flags: string[] = [];
    const dstNode = nodeById.get(dst);
    const srcNode = nodeById.get(src);
    if (dstNode && isSurveyLike(dstNode as Parameters<typeof isSurveyLike>[0])) {
      flags.push("引用側がサーベイらしい");
    }
    if (srcNode && isSurveyLike(srcNode as Parameters<typeof isSurveyLike>[0])) {
      flags.push("被引用側がサーベイらしい");
    }
    const sy = yearOf(src);
    const dy = yearOf(dst);
    if (sy !== null && dy !== null && dy < sy) flags.push("引用側の年が被引用側より前");
    if (pairKeys.has(`${dst}->${src}`)) flags.push("逆向きの辺もある（2 サイクル）");
    if (!quoteFromRationale(rationale)) flags.push("引用文なし");
    relations.push({
      src,
      dst,
      relation,
      src_title: titleOf(src),
      src_year: sy,
      dst_title: titleOf(dst),
      dst_year: dy,
      confidence: num(edge.confidence ?? edge.conf),
      method: str(classification.method),
      model: str(classification.model),
      rationale,
      quote: quoteFromRationale(rationale),
      flags,
      verdict: null,
      corrected_relation: null,
      note: "",
      suggestion: { verdict: null, corrected_relation: null, assessment: null, reason: "" },
    });
  }
  relations.sort(
    (a, b) =>
      sortKey(a.relation, b.relation) ||
      (a.dst_year ?? 0) - (b.dst_year ?? 0) ||
      sortKey(`${a.src}->${a.dst}`, `${b.src}->${b.dst}`),
  );

  return {
    schema_version: AUDIT_DRAFT_SCHEMA_VERSION,
    collection_id: collectionId,
    theme: str(meta.theme) ?? collectionId,
    lineage_path: lineagePath,
    input_sha256: sha256Hex(lineageBytes),
    generated_at: generatedAt,
    strong_relations: strong,
    instructions: [
      "nodes[].on_topic: テーマ内なら true、テーマ外なら false",
      "nodes[].metadata_ok: 題名・年・著者・DOI/arXiv が正しければ true（違えば false と note に理由）",
      'relations[].verdict: 関係の種類が正しければ "correct"、誤りなら "wrong"（正しい種類を corrected_relation に。関係が成り立たないなら null のまま note に理由）',
      "auditor に監査者名、audited_at に監査日時（例 2026-10-12T10:00:00+09:00）",
      "suggestion は第二審査の下書き（判定ではない）。未記入の項目を suggestion で埋めてよい場合だけ accept_suggestions_for_unset を true にする",
      "編集後: pnpm exec tsx apps/pipeline/src/lineage/quality/auditDraftCli.ts import --draft <このファイル>（--write で監査記録に追記）",
    ],
    auditor: "",
    audited_at: "",
    accept_suggestions_for_unset: false,
    nodes,
    relations,
  };
}

function md(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function yesNo(value: boolean | null): string {
  return value === null ? "—" : value ? "はい" : "いいえ";
}

function assessmentJa(a: Assessment | null): string {
  return a === "looks_right" ? "妥当" : a === "doubtful" ? "**要確認**" : "—";
}

/** Renders a draft as the Japanese Markdown sheet the auditor reads. */
export function renderAuditSheet(draft: AuditDraft): string {
  const lines: string[] = [];
  const doubtfulNodes = draft.nodes.filter((n) => n.suggestion.assessment === "doubtful");
  const doubtfulRels = draft.relations.filter((r) => r.suggestion.assessment === "doubtful");
  lines.push(`# 監査シート: ${draft.theme}（${draft.collection_id}）`);
  lines.push("");
  lines.push(`- 対象: \`${draft.lineage_path}\``);
  lines.push(
    `- input_sha256: \`${draft.input_sha256}\`（この値の成果物だけに有効。作り直したら監査し直し）`,
  );
  lines.push(`- 下書き作成: ${draft.generated_at}`);
  lines.push(
    `- 範囲（設計 41 D5）: ノード ${draft.nodes.length} 件すべて、強い主張の関係（${draft.strong_relations.join("・")}）${draft.relations.length} 件すべて`,
  );
  lines.push(
    `- 第二審査の下書き: 要確認 ノード ${doubtfulNodes.length} 件・関係 ${doubtfulRels.length} 件（「妥当／要確認」は判定ではない。判定は監査者が JSON に書く）`,
  );
  if (draft.nodes.length > SAMPLE_LIMIT) {
    lines.push(
      `- ノードが ${SAMPLE_LIMIT} 件を超えるので、監査記録の sample_labels には ${SAMPLE_LIMIT} 件だけ入る。テーマ外・書誌の誤りと判定したノードは必ず入れ、残りは決まった順で選ぶ（取り込み時に自動）`,
    );
  }
  if (doubtfulNodes.length + doubtfulRels.length > 0) {
    lines.push("");
    lines.push("## 要確認の一覧（第二審査）");
    lines.push("");
    for (const n of doubtfulNodes) {
      lines.push(
        `- ノード「${md(n.title)}」(${n.year ?? "?"}): テーマ内 ${yesNo(n.suggestion.on_topic)}・書誌 ${yesNo(n.suggestion.metadata_ok)}。${md(n.suggestion.reason)}`,
      );
    }
    draft.relations.forEach((r, i) => {
      if (r.suggestion.assessment !== "doubtful") return;
      const fix =
        r.suggestion.verdict === "wrong"
          ? `誤り → ${r.suggestion.corrected_relation ?? "関係なし"}`
          : "種類は正しいが根拠が弱い";
      lines.push(
        `- R${i + 1} \`${r.relation}\` 「${md(shortTitle(r.src_title))}」→「${md(shortTitle(r.dst_title))}」: ${fix}`,
      );
    });
  }
  lines.push("");
  lines.push("## 判定の書き方");
  lines.push("");
  lines.push("同じ名前の `.audit-pending.json` を編集する（この Markdown は表示用）。");
  lines.push("");
  for (const item of draft.instructions) lines.push(`- ${item}`);
  lines.push("");
  lines.push("関係の種類の意味（src＝被引用側・古い方、dst＝引用側・新しい方）:");
  lines.push("");
  for (const rel of RELATION_CHOICES) lines.push(`- \`${rel}\`: ${RELATION_MEANING_JA[rel]}`);
  lines.push("");
  lines.push(`## ノード（${draft.nodes.length} 件）`);
  lines.push("");
  lines.push("| # | 題名 | 年 | 著者・掲載 | リンク | 採用の理由 | 第二審査 | 理由 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  draft.nodes.forEach((n, i) => {
    const marks = [
      n.is_root ? "根" : "",
      n.is_focus ? "フォーカス" : "",
      n.survey_like ? "サーベイ" : "",
    ]
      .filter(Boolean)
      .join("・");
    const authors = n.authors.slice(0, 3).join(", ") + (n.authors.length > 3 ? " ほか" : "");
    const links = Object.entries(n.links)
      .map(
        ([k, v]) =>
          `[${k === "semantic_scholar" ? "S2" : k === "openalex" ? "OpenAlex" : k === "doi" ? "DOI" : "arXiv"}](${v})`,
      )
      .join(" ");
    const suggested =
      n.suggestion.assessment === null
        ? "—"
        : `${assessmentJa(n.suggestion.assessment)}（テーマ内: ${yesNo(n.suggestion.on_topic)}、書誌: ${yesNo(n.suggestion.metadata_ok)}）`;
    lines.push(
      `| ${i + 1} | ${md(n.title)}${marks ? ` 〔${marks}〕` : ""}<br>\`${n.node_id}\` | ${n.year ?? "—"} | ${md(authors || "—")} / ${md(n.venue ?? "—")} | ${links || "—"} | ${md(n.why_included)} | ${suggested} | ${md(n.suggestion.reason || "")} |`,
    );
  });
  lines.push("");
  lines.push(`## 強い主張の関係（${draft.relations.length} 件）`);
  lines.push("");
  draft.relations.forEach((r, i) => {
    lines.push(
      `### R${i + 1}. \`${r.relation}\`: 「${md(r.src_title)}」(${r.src_year ?? "?"}) → 「${md(r.dst_title)}」(${r.dst_year ?? "?"})`,
    );
    lines.push("");
    lines.push(`- 意味: ${RELATION_MEANING_JA[r.relation] ?? r.relation}`);
    lines.push(`- 辺: \`${r.src}\` → \`${r.dst}\``);
    lines.push(
      `- 分類: ${r.method ?? "—"}${r.model ? `（${r.model}）` : ""}、確信度 ${r.confidence ?? "—"}`,
    );
    if (r.quote) lines.push(`- 引用文（Semantic Scholar）: “${md(r.quote)}”`);
    lines.push(`- 理由欄: ${md(r.rationale || "—")}`);
    if (r.flags.length > 0) lines.push(`- 自動の注意: ${r.flags.join("・")}`);
    if (r.suggestion.assessment !== null) {
      const fix =
        r.suggestion.verdict === "wrong"
          ? `、修正案 ${r.suggestion.corrected_relation ? `\`${r.suggestion.corrected_relation}\`` : "（関係なし）"}`
          : "";
      lines.push(
        `- 第二審査: ${assessmentJa(r.suggestion.assessment)}${fix}。${md(r.suggestion.reason)}`,
      );
    }
    lines.push("");
  });
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Import: edited draft -> lineage-audit-fixtures-v1 entry
// ---------------------------------------------------------------------------

export class AuditImportError extends Error {
  constructor(public readonly problems: string[]) {
    super(`audit draft is not ready to import:\n- ${problems.join("\n- ")}`);
    this.name = "AuditImportError";
  }
}

export interface NodeLabel {
  node_id: string;
  on_topic: boolean;
  metadata_ok: boolean;
  note?: string;
}

export interface EdgeLabel {
  src: string;
  dst: string;
  relation: string;
  verdict: "correct" | "wrong";
  corrected_relation?: string;
  note?: string;
}

export interface FixtureEntry {
  collection_id: string;
  input_sha256: string;
  draft_sha256: string;
  reviewer: string;
  reviewed_at: string;
  focus_labels: NodeLabel[];
  sample_labels: NodeLabel[];
  edge_labels: EdgeLabel[];
}

export interface ImportResult {
  entry: FixtureEntry;
  warnings: string[];
  stats: {
    nodes: number;
    off_topic: number;
    metadata_wrong: number;
    relations: number;
    wrong_relations: number;
    sampled: number;
  };
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Turns an edited draft into a fixtures entry. Fails (listing every
 * problem) when a verdict is missing, the auditor/date are missing, or the
 * draft no longer matches the artifact bytes / its strong edges.
 */
export function importAuditDraft(options: {
  draft: unknown;
  draftBytes: Buffer;
  lineage: unknown;
  lineageBytes: Buffer;
  strongRelations?: readonly string[];
}): ImportResult {
  const { draft, draftBytes, lineage, lineageBytes } = options;
  const strong = new Set(options.strongRelations ?? DEFAULT_STRONG_RELATIONS);
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isMapping(draft) || draft.schema_version !== AUDIT_DRAFT_SCHEMA_VERSION) {
    throw new AuditImportError([`schema_version must be ${AUDIT_DRAFT_SCHEMA_VERSION}`]);
  }
  if (!isMapping(lineage) || !Array.isArray(lineage.nodes) || !Array.isArray(lineage.edges)) {
    throw new AuditImportError(["lineage artifact has no nodes/edges arrays"]);
  }
  const inputSha = sha256Hex(lineageBytes);
  if (draft.input_sha256 !== inputSha) {
    problems.push(
      `input_sha256 mismatch: draft ${String(draft.input_sha256)} vs current artifact ${inputSha} (regenerated? draft again)`,
    );
  }
  const auditor = str(draft.auditor);
  if (!auditor) problems.push("auditor is empty");
  const auditedAt = str(draft.audited_at);
  if (!auditedAt || !ISO_WITH_ZONE.test(auditedAt) || Number.isNaN(Date.parse(auditedAt))) {
    problems.push("audited_at must be an ISO date-time with a timezone");
  }
  const accept = draft.accept_suggestions_for_unset === true;
  if (accept)
    warnings.push("accept_suggestions_for_unset=true: unset verdicts were taken from suggestions");

  const artifactNodes = new Map<string, Record<string, unknown>>();
  for (const node of lineage.nodes) {
    if (isMapping(node) && str(node.id)) artifactNodes.set(node.id as string, node);
  }
  const draftNodes = Array.isArray(draft.nodes) ? draft.nodes.filter(isMapping) : [];
  const labels = new Map<string, NodeLabel>();
  for (const row of draftNodes) {
    const id = str(row.node_id);
    if (!id || !artifactNodes.has(id)) {
      problems.push(`node not in artifact: ${String(row.node_id)}`);
      continue;
    }
    if (labels.has(id)) {
      problems.push(`node listed twice: ${id}`);
      continue;
    }
    const suggestion = isMapping(row.suggestion) ? row.suggestion : {};
    const pick = (field: "on_topic" | "metadata_ok"): boolean | null => {
      if (typeof row[field] === "boolean") return row[field] as boolean;
      if (row[field] !== null && row[field] !== undefined) return null;
      return accept && typeof suggestion[field] === "boolean"
        ? (suggestion[field] as boolean)
        : null;
    };
    const onTopic = pick("on_topic");
    const metadataOk = pick("metadata_ok");
    if (onTopic === null) problems.push(`node ${id}: on_topic not set`);
    if (metadataOk === null) problems.push(`node ${id}: metadata_ok not set`);
    if (onTopic === null || metadataOk === null) continue;
    const label: NodeLabel = { node_id: id, on_topic: onTopic, metadata_ok: metadataOk };
    const note = str(row.note);
    if (note) label.note = note;
    labels.set(id, label);
  }
  for (const id of artifactNodes.keys()) {
    if (!draftNodes.some((row) => row.node_id === id))
      problems.push(`node missing from draft: ${id}`);
  }

  const strongKeys = new Set<string>();
  for (const edge of lineage.edges) {
    if (!isMapping(edge)) continue;
    const rel = relationOf(edge);
    const src = str(edge.src);
    const dst = str(edge.dst);
    if (src && dst && rel && strong.has(rel)) strongKeys.add(`${src}->${dst}:${rel}`);
  }
  const draftRels = Array.isArray(draft.relations) ? draft.relations.filter(isMapping) : [];
  const edgeLabels: EdgeLabel[] = [];
  const seen = new Set<string>();
  for (const row of draftRels) {
    const key = `${String(row.src)}->${String(row.dst)}:${String(row.relation)}`;
    if (!strongKeys.has(key)) {
      problems.push(`relation not a strong edge of the artifact: ${key}`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`relation listed twice: ${key}`);
      continue;
    }
    seen.add(key);
    const suggestion = isMapping(row.suggestion) ? row.suggestion : {};
    let verdict = row.verdict;
    let corrected = row.corrected_relation;
    if ((verdict === null || verdict === undefined) && accept) {
      verdict = suggestion.verdict;
      corrected = suggestion.corrected_relation;
    }
    if (verdict !== "correct" && verdict !== "wrong") {
      problems.push(`relation ${key}: verdict not set`);
      continue;
    }
    const label: EdgeLabel = {
      src: row.src as string,
      dst: row.dst as string,
      relation: row.relation as string,
      verdict,
    };
    if (verdict === "correct" && corrected !== null && corrected !== undefined) {
      problems.push(`relation ${key}: corrected_relation must be null when verdict is correct`);
      continue;
    }
    if (verdict === "wrong" && typeof corrected === "string" && corrected) {
      if (!RELATION_CHOICES.includes(corrected)) {
        problems.push(`relation ${key}: unknown corrected_relation ${corrected}`);
        continue;
      }
      label.corrected_relation = corrected;
    }
    const note = str(row.note);
    if (note) label.note = note;
    edgeLabels.push(label);
  }
  for (const key of [...strongKeys].sort(sortKey)) {
    if (!seen.has(key)) problems.push(`strong relation missing from draft: ${key}`);
  }
  if (problems.length > 0) throw new AuditImportError(problems);

  const all = [...labels.values()];
  const focusIds = new Set(
    [...artifactNodes.entries()].filter(([, n]) => n.is_focus === true).map(([id]) => id),
  );
  const focusLabels = all
    .filter((l) => focusIds.has(l.node_id))
    .sort((a, b) => sortKey(a.node_id, b.node_id));
  // Sample: every node when <= SAMPLE_LIMIT. Otherwise all negative
  // verdicts first (they must never be dropped), then a fixed hash order.
  let sample: NodeLabel[];
  if (all.length <= SAMPLE_LIMIT) {
    sample = [...all];
  } else {
    const negative = all.filter((l) => !l.on_topic || !l.metadata_ok);
    const rest = all
      .filter((l) => l.on_topic && l.metadata_ok)
      .sort((a, b) =>
        sortKey(sha256Hex(`${inputSha}:${a.node_id}`), sha256Hex(`${inputSha}:${b.node_id}`)),
      );
    sample = [...negative.sort((a, b) => sortKey(a.node_id, b.node_id)), ...rest].slice(
      0,
      SAMPLE_LIMIT,
    );
    if (negative.length > SAMPLE_LIMIT) {
      warnings.push(
        `${negative.length} negative node verdicts; only ${SAMPLE_LIMIT} fit in sample_labels`,
      );
    }
  }
  sample.sort((a, b) => sortKey(a.node_id, b.node_id));
  const offTopic = all.filter((l) => !l.on_topic).length;
  const metadataWrong = all.filter((l) => !l.metadata_ok).length;
  if (all.length > 0 && offTopic / all.length > 0.1) {
    warnings.push(`off-topic share over all nodes is ${offTopic}/${all.length} (> 10%)`);
  }
  const wrongRelations = edgeLabels.filter((l) => l.verdict === "wrong").length;
  if (wrongRelations > 0) {
    warnings.push(
      `${wrongRelations} relation(s) judged wrong: golden_fixture will fail until the theme is regenerated and re-audited`,
    );
  }
  edgeLabels.sort((a, b) =>
    sortKey(`${a.src}->${a.dst}:${a.relation}`, `${b.src}->${b.dst}:${b.relation}`),
  );
  return {
    entry: {
      collection_id: String(draft.collection_id),
      input_sha256: inputSha,
      draft_sha256: sha256Hex(draftBytes),
      reviewer: auditor as string,
      reviewed_at: auditedAt as string,
      focus_labels: focusLabels,
      sample_labels: sample,
      edge_labels: edgeLabels,
    },
    warnings,
    stats: {
      nodes: all.length,
      off_topic: offTopic,
      metadata_wrong: metadataWrong,
      relations: edgeLabels.length,
      wrong_relations: wrongRelations,
      sampled: sample.length,
    },
  };
}

/** Replaces (or appends) the entry for `entry.collection_id` in a fixtures document. */
export function mergeFixtureEntry(
  fixtures: unknown,
  entry: FixtureEntry,
): { schema_version: string; collections: unknown[] } {
  const doc = isMapping(fixtures) ? fixtures : {};
  const collections = Array.isArray(doc.collections) ? doc.collections : [];
  const kept = collections.filter(
    (row) => !(isMapping(row) && row.collection_id === entry.collection_id),
  );
  const next = [...kept, entry].sort((a, b) =>
    sortKey(
      String((a as Record<string, unknown>).collection_id),
      String((b as Record<string, unknown>).collection_id),
    ),
  );
  return { schema_version: "lineage-audit-fixtures-v1", collections: next };
}
