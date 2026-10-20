"use client";

/**
 * Whether the collection on screen is human-audited (D-R2-40). Strong
 * relation labels (拡張・対比・置き換え…) come from rules over a citation
 * sentence, so unless the collection is audited every label is shown as a
 * candidate ("拡張（候補）"). The default is `false` (candidate wording):
 * a surface that forgets the provider can only be too modest, never too
 * confident.
 */
import { createContext, useContext } from "react";

const RelationAuditContext = createContext(false);

export const RelationAuditProvider = RelationAuditContext.Provider;

/** True only inside a provider that was given `true` (audited tier). */
export function useRelationAudited(): boolean {
  return useContext(RelationAuditContext);
}
