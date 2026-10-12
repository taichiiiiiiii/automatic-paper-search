/**
 * R2-37 test helpers: frozen copies of a real published theme (FlashAttention,
 * 14 nodes / 46 edges / 4 lineage relations, audited when frozen), its audit
 * fixture and the publication policy at freeze time, plus synthetic variants.
 * Never read the live `data/published` tree here: regeneration changes it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "publish-guard");
export const GUARD_POLICY = join(DIR, "policy.json");
export const GUARD_AUDIT_FIXTURES = join(DIR, "audit-fixtures.json");
export const FA_SLUG = "flash-attention";
export const FA_THEME = "Flash Attention";

type Json = Record<string, unknown>;
type Node = Json & { id: string; is_focus?: boolean };
type Edge = Json & { src: string; dst: string; relation: string; rel: string };
export interface Lineage extends Json {
  nodes: Node[];
  edges: Edge[];
  meta: Json;
}

/** The exact frozen bytes (the audit fixture is bound to their sha256). */
export function faText(): string {
  return readFileSync(join(DIR, "flash-attention-lineage.json"), "utf-8");
}

export function fa(): Lineage {
  return JSON.parse(faText()) as Lineage;
}

export function serialize(l: Lineage): string {
  return `${JSON.stringify(l, null, 2)}\n`;
}

/** The incident shape: every lineage relation demoted to `baseline_only`,
 * so `lineage_relation_count` fails (0 < 3) and the tier is `blocked`. */
export function withoutLineageRelations(l: Lineage = fa()): Lineage {
  return {
    ...l,
    edges: l.edges.map((e) =>
      e.relation === "baseline_only"
        ? e
        : { ...e, relation: "baseline_only", rel: "baseline_only" },
    ),
  };
}

/** `extra` copies of a non-focus node (new ids) linked like the original,
 * so the graph grows past the 15-node sparse threshold and stays valid. */
export function grown(extra: number, l: Lineage = fa()): Lineage {
  const template = l.nodes.find((n) => n.is_focus !== true);
  if (!template) throw new Error("no non-focus node to clone");
  const link = l.edges.find((e) => e.src === template.id || e.dst === template.id);
  if (!link) throw new Error("template node has no edge");
  const nodes = [...l.nodes];
  const edges = [...l.edges];
  for (let i = 0; i < extra; i += 1) {
    const id = `openalex:W9999999${String(i).padStart(3, "0")}`;
    const { arxiv_id: _a, doi: _d, aliases: _x, ...rest } = template;
    nodes.push({ ...rest, id, title: `${String(template.title)} (copy ${i})`, aliases: [] });
    edges.push({
      ...link,
      src: link.src === template.id ? id : link.src,
      dst: link.dst === template.id ? id : link.dst,
    });
  }
  const breakdown = { ...(l.meta.provenance_breakdown as Record<string, number>) };
  const method = (link.provenance as { classification: { method: string } }).classification.method;
  breakdown[method] = (breakdown[method] ?? 0) + extra;
  return { ...l, nodes, edges, meta: { ...l.meta, provenance_breakdown: breakdown } };
}

/** The published-file shape of an auto-expanded build. */
export function withDepth(depth: number, l: Lineage = fa()): Lineage {
  return { ...l, meta: { ...l.meta, depth } };
}
