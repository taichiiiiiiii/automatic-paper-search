/** R2-37: publication-tier guard (`theme/publishGuard.ts`). */
import { describe, expect, it } from "vitest";
import {
  evaluateTheme,
  loadGuardContext,
  MIN_KEPT_NODE_SHARE,
  type PublishedTheme,
  publishedTheme,
  regressionRefusal,
  type ThemeVerdict,
} from "../../../src/lineage/theme/publishGuard.js";
import {
  FA_SLUG,
  faText,
  GUARD_AUDIT_FIXTURES,
  GUARD_POLICY,
  grown,
  serialize,
  withDepth,
  withoutLineageRelations,
} from "./publishGuardFixtures.js";

const NOW = () => new Date("2026-10-12T12:00:00Z");
const ctx = loadGuardContext({
  policyPath: GUARD_POLICY,
  fixturesPath: GUARD_AUDIT_FIXTURES,
  minClassifiedRate: 0.8,
  now: NOW,
});
const buf = (t: string) => Buffer.from(t, "utf-8");

describe("evaluateTheme (same checks as the release's quality table)", () => {
  it("a complete, evidence-backed build is unaudited (a fresh build has no audit)", () => {
    const v = evaluateTheme(buf(faText()), FA_SLUG, ctx);
    expect(v).toMatchObject({ tier: "unaudited", nodeCount: 14, edgeCount: 46, failed: [] });
  });

  it("too few lineage relations (the LoRA incident) is blocked, naming the check", () => {
    const v = evaluateTheme(buf(serialize(withoutLineageRelations())), FA_SLUG, ctx);
    expect(v.tier).toBe("blocked");
    expect(v.failed.join("\n")).toMatch(/lineage_relation_count failed \(observed 0, expected 3\)/);
  });

  it("reads the threshold from the policy file, not a constant", () => {
    const strict = { ...ctx, policy: { ...ctx.policy, theme_min_lineage_edges: 5 } };
    const v = evaluateTheme(buf(faText()), FA_SLUG, strict);
    expect(v.tier).toBe("blocked");
    expect(v.failed.join("\n")).toMatch(/lineage_relation_count failed \(observed 4, expected 5\)/);
  });

  it("an unparsable payload is blocked", () => {
    expect(evaluateTheme(buf("{not json"), FA_SLUG, ctx).tier).toBe("blocked");
  });
});

describe("publishedTheme", () => {
  it("is audited when the golden fixture matches the exact bytes", () => {
    const p = publishedTheme(buf(faText()), FA_SLUG, ctx);
    expect(p).toMatchObject({ tier: "audited", nodeCount: 14, depth: 1, seedCount: 5 });
  });

  it("a published file whose audit is bound to other bytes is blocked (as the release rates it)", () => {
    const p = publishedTheme(buf(serialize(withDepth(2))), FA_SLUG, ctx);
    expect(p).toMatchObject({ tier: "blocked", golden: "failed", failed: [], depth: 2 });
  });

  it("records meta.depth of an unaudited theme", () => {
    const p = publishedTheme(buf(serialize(withDepth(2))), "other-theme", ctx);
    expect(p).toMatchObject({ tier: "unaudited", golden: "unknown", depth: 2 });
  });

  it("is null when nothing is published", () => {
    expect(publishedTheme(null, FA_SLUG, ctx)).toBeNull();
  });
});

describe("regressionRefusal", () => {
  const pub = (tier: PublishedTheme["tier"], nodeCount = 74): PublishedTheme => ({
    tier,
    nodeCount,
    edgeCount: 327,
    failed: [],
    golden: tier === "audited" ? "passed" : "unknown",
    depth: 2,
    seedCount: 10,
  });
  const cand = (tier: ThemeVerdict["tier"], nodeCount: number): ThemeVerdict => ({
    tier,
    nodeCount,
    edgeCount: 39,
    failed: tier === "blocked" ? ["lineage_relation_count failed (observed 2, expected 3)"] : [],
    golden: "unknown",
  });
  const opts = { allowShrink: false };

  it("refuses a blocked build over a published unaudited or audited theme", () => {
    for (const tier of ["unaudited", "audited"] as const) {
      const msg = regressionRefusal(pub(tier), cand("blocked", 21), opts);
      expect(msg).toMatch(new RegExp(`published ${tier} theme \\(74 nodes / 327 edges\\)`));
      expect(msg).toMatch(/lineage_relation_count failed \(observed 2, expected 3\)/);
    }
  });

  it("a blocked build is refused even with allowShrink", () => {
    expect(
      regressionRefusal(pub("unaudited"), cand("blocked", 74), { allowShrink: true }),
    ).not.toBe(null);
  });

  it(`refuses a publishable build under ${MIN_KEPT_NODE_SHARE * 100}% of the published nodes unless allowShrink`, () => {
    expect(regressionRefusal(pub("unaudited"), cand("unaudited", 36), opts)).toMatch(
      /36 nodes .*< 50% of the published nodes.*--allow-shrink/,
    );
    expect(regressionRefusal(pub("unaudited"), cand("unaudited", 36), { allowShrink: true })).toBe(
      null,
    );
    expect(regressionRefusal(pub("unaudited"), cand("unaudited", 37), opts)).toBe(null);
  });

  it("does not protect a theme that is not on the site (blocked) or not published", () => {
    expect(regressionRefusal(pub("blocked"), cand("blocked", 3), opts)).toBe(null);
    expect(regressionRefusal(null, cand("blocked", 3), opts)).toBe(null);
  });

  it("accepts an equal-or-better rebuild of an unaudited theme", () => {
    const slug = "other-theme";
    const grownV = evaluateTheme(buf(serialize(grown(3))), slug, ctx, { withAudit: true });
    expect(grownV.tier).toBe("unaudited");
    const p = publishedTheme(buf(faText()), slug, ctx);
    expect(p?.tier).toBe("unaudited");
    expect(regressionRefusal(p, grownV, opts)).toBe(null);
  });

  it("an audited theme's rebuild would be blocked by its stale audit: refused unless allowReaudit", () => {
    const p = publishedTheme(buf(faText()), FA_SLUG, ctx);
    expect(p?.tier).toBe("audited");
    const rebuilt = evaluateTheme(buf(serialize(grown(3))), FA_SLUG, ctx, { withAudit: true });
    expect(rebuilt).toMatchObject({ tier: "blocked", golden: "failed", failed: [] });
    expect(regressionRefusal(p, rebuilt, opts)).toMatch(/re-audited.*--allow-reaudit/);
    expect(regressionRefusal(p, rebuilt, { allowShrink: false, allowReaudit: true })).toBe(null);
    // allowReaudit never lets a build that fails its own gate through.
    const weak = evaluateTheme(buf(serialize(withoutLineageRelations())), FA_SLUG, ctx, {
      withAudit: true,
    });
    expect(regressionRefusal(p, weak, { allowShrink: true, allowReaudit: true })).toMatch(
      /lineage_relation_count/,
    );
  });

  it("without withAudit only the build's own gate is judged (auto-expand trigger)", () => {
    expect(evaluateTheme(buf(serialize(grown(3))), FA_SLUG, ctx).tier).toBe("unaudited");
  });
});
