// R2-26 (design 51): shared source labels / abstract licences.
import { describe, expect, it } from "vitest";
import { abstractContradictsTitle } from "../../src/abstract-sanity/index.js";
import {
  ABSTRACT_LICENSE,
  authorCredit,
  isAbstractSource,
  nativeAbstractSource,
  SOURCE_LABEL,
} from "../../src/licensing/index.js";

describe("licensing", () => {
  it("licenses only arXiv / OpenReview / ACL abstracts as published; CVF fails closed", () => {
    expect(nativeAbstractSource("arxiv")).toBe("arxiv");
    expect(nativeAbstractSource("openreview")).toBe("openreview");
    expect(nativeAbstractSource("acl_anthology")).toBe("acl_anthology");
    expect(nativeAbstractSource("cvf")).toBeNull();
    expect(nativeAbstractSource("anything")).toBeNull();
    expect(ABSTRACT_LICENSE.acl_anthology?.id).toBe("CC-BY-4.0");
    expect(ABSTRACT_LICENSE.s2_tldr?.id).toBe("ODC-BY-1.0");
    expect(ABSTRACT_LICENSE.none).toBeNull();
    expect(SOURCE_LABEL.cvf).toBe("CVF Open Access");
    expect(isAbstractSource("none")).toBe(true);
    expect(isAbstractSource("cvf")).toBe(false);
  });

  it("formats an author credit", () => {
    expect(authorCredit(["Iz Beltagy", "Matthew E. Peters", "Arman Cohan"])).toBe("Beltagy et al.");
    expect(authorCredit(["A B", "C D"])).toBe("B & D");
    expect(authorCredit(["Solo"])).toBe("Solo");
    expect(authorCredit([])).toBe("");
    expect(authorCredit(undefined)).toBe("");
  });

  it("abstract sanity flags the Longformer / Murmurative mismatch", () => {
    const murm =
      "The quadratic complexity of standard attention remains the dominant bottleneck for training and deploying large language models on long sequences. We introduce Murmurative Attention, a novel attention mechanism that replaces pairwise token-token interactions with token-to-slot interactions.";
    expect(abstractContradictsTitle("Longformer: The Long-Document Transformer", murm)).toBe(true);
  });
});
