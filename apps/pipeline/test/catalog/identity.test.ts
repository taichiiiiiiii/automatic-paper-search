import { describe, expect, it } from "vitest";
import {
  IdentityError,
  identityFromUrl,
  makePaperId,
  normalizeAlias,
} from "../../src/catalog/identity.js";

describe("identityFromUrl", () => {
  it("parses a modern arXiv /abs/ URL", () => {
    const id = identityFromUrl("https://arxiv.org/abs/2301.01234");
    expect(id.source).toBe("arxiv");
    expect(id.sourceId).toBe("2301.01234");
    expect(id.paperId).toMatch(/^[0-9a-f]{40}$/);
  });

  it("strips the version suffix from an arXiv id", () => {
    const withV = identityFromUrl("https://arxiv.org/abs/2301.01234v3");
    const withoutV = identityFromUrl("https://arxiv.org/abs/2301.01234");
    expect(withV.paperId).toBe(withoutV.paperId);
  });

  it("normalizes a /pdf/<id>.pdf URL the same as /abs/<id>", () => {
    const abs = identityFromUrl("https://arxiv.org/abs/2301.01234");
    const pdf = identityFromUrl("https://arxiv.org/pdf/2301.01234.pdf");
    expect(pdf.paperId).toBe(abs.paperId);
  });

  it("parses a legacy arXiv id (archive/number)", () => {
    const id = identityFromUrl("https://arxiv.org/abs/hep-th/9901001");
    expect(id.source).toBe("arxiv");
    expect(id.sourceId).toBe("hep-th/9901001");
  });

  it("parses an OpenReview forum URL", () => {
    const id = identityFromUrl("https://openreview.net/forum?id=abc123DEF");
    expect(id.source).toBe("openreview");
    expect(id.sourceId).toBe("abc123DEF");
  });

  it("parses an ACL Anthology URL", () => {
    const id = identityFromUrl("https://aclanthology.org/2025.acl-long.1");
    expect(id.source).toBe("acl_anthology");
    expect(id.sourceId).toBe("2025.acl-long.1");
  });

  it("parses a CVF Open Access URL", () => {
    const id = identityFromUrl(
      "https://openaccess.thecvf.com/content/CVPR2025/html/Doe_Example_Paper_CVPR_2025_paper.html",
    );
    expect(id.source).toBe("cvf");
    expect(id.sourceId).toBe("Doe_Example_Paper_CVPR_2025_paper");
  });

  it("is deterministic (same URL -> same paper_id every time)", () => {
    const a = identityFromUrl("https://arxiv.org/abs/2301.01234");
    const b = identityFromUrl("https://arxiv.org/abs/2301.01234");
    expect(a.paperId).toBe(b.paperId);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => identityFromUrl("ftp://arxiv.org/abs/2301.01234")).toThrow(IdentityError);
  });

  it("rejects an unknown host", () => {
    expect(() => identityFromUrl("https://example.com/abs/2301.01234")).toThrow(IdentityError);
  });

  it("rejects embedded credentials", () => {
    expect(() => identityFromUrl("https://user:pass@arxiv.org/abs/2301.01234")).toThrow(
      IdentityError,
    );
  });

  it("rejects an empty URL", () => {
    expect(() => identityFromUrl("")).toThrow(IdentityError);
  });

  it("rejects an arXiv URL with a query string", () => {
    expect(() => identityFromUrl("https://arxiv.org/abs/2301.01234?x=1")).toThrow(IdentityError);
  });

  it("rejects an OpenReview URL with no id", () => {
    expect(() => identityFromUrl("https://openreview.net/forum")).toThrow(IdentityError);
  });
});

describe("normalizeAlias", () => {
  it("normalizes an arxiv alias the same way as a URL-derived id", () => {
    const [source, id] = normalizeAlias("arxiv", "2301.01234v2");
    expect(source).toBe("arxiv");
    expect(id).toBe("2301.01234");
  });

  it("rejects an unknown namespace", () => {
    expect(() => normalizeAlias("ssrn", "123")).toThrow(IdentityError);
  });
});

describe("makePaperId", () => {
  it("is a 40-hex-character digest (sha256, truncated — not sha1)", () => {
    const id = makePaperId("arxiv", "2301.01234");
    expect(id).toMatch(/^[0-9a-f]{40}$/);
  });

  it("differs for different source ids", () => {
    expect(makePaperId("arxiv", "2301.01234")).not.toBe(makePaperId("arxiv", "2301.01235"));
  });
});
