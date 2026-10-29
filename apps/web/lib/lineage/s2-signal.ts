/**
 * #444: Semantic Scholar's own judgement that a citation is influential and
 * about the citing paper's methodology. It is shown on plain citation
 * edges only (a thicker, more opaque line and one sentence of text); it never
 * changes the relation, the strong-relation count or a publication check.
 */
export const S2_INFLUENTIAL_LABEL_JA = "Semantic Scholar が影響の大きい方法論の引用と判定";

export function isS2Influential(edge: { s2_signal?: string | null }): boolean {
  return edge.s2_signal === "influential_methodology";
}
