import { describe, expect, it } from "vitest";
import { seedScopeNotice } from "../../lib/themes-tree";

describe("seedScopeNotice (#473)", () => {
  it("names the sense shown and how many were set aside", () => {
    const n = seedScopeNotice({
      seed_scope: {
        subfield: "Artificial Intelligence",
        excluded_surveys: ["openalex:W1"],
        excluded_canonical: 2,
      },
    });
    expect(n).toContain("「Artificial Intelligence」");
    expect(n).toContain("3 件");
  });
  it("is silent when nothing was excluded or the meta is absent", () => {
    expect(
      seedScopeNotice({
        seed_scope: { subfield: "AI", excluded_surveys: [], excluded_canonical: 0 },
      }),
    ).toBeNull();
    expect(seedScopeNotice({})).toBeNull();
    expect(seedScopeNotice(undefined)).toBeNull();
  });
});
