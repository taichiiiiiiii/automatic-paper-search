// New tests for §4.5's DISPATCH_MODE sanity gate.

import { PUBLIC_ORIGIN } from "@paperpilot/core/site";
import { describe, expect, it } from "vitest";
import { PRODUCTION_ORIGINS } from "../../src/config.js";
import { checkDispatchMode } from "../../src/lib/dispatch-mode.js";

const PRODUCTION_ORIGIN = "https://taichiiiiiiii.github.io";

describe("checkDispatchMode", () => {
  it("rejects an unset DISPATCH_MODE", () => {
    const result = checkDispatchMode({ GH_REF: "feat/ts-migration" }, "https://preview.test");
    expect(result.ok).toBe(false);
  });

  it("rejects an unrecognised DISPATCH_MODE value", () => {
    const result = checkDispatchMode(
      { DISPATCH_MODE: "yolo", GH_REF: "feat/ts-migration" },
      "https://preview.test",
    );
    expect(result.ok).toBe(false);
  });

  it("live mode requires a non-empty PAT", () => {
    expect(
      checkDispatchMode({ DISPATCH_MODE: "live", GH_REF: "develop" }, PRODUCTION_ORIGIN).ok,
    ).toBe(false);
    expect(
      checkDispatchMode(
        { DISPATCH_MODE: "live", GH_REF: "develop", GH_DISPATCH_PAT: "  " },
        PRODUCTION_ORIGIN,
      ).ok,
    ).toBe(false);
  });

  it("live mode with a PAT succeeds regardless of ref/origin", () => {
    const result = checkDispatchMode(
      { DISPATCH_MODE: "live", GH_REF: "develop", GH_DISPATCH_PAT: "ghp_x" },
      PRODUCTION_ORIGIN,
    );
    expect(result).toEqual({ ok: true, mode: "live" });
  });

  it("dry-run refuses when GH_REF is develop", () => {
    const result = checkDispatchMode(
      { DISPATCH_MODE: "dry-run", GH_REF: "develop" },
      "https://preview.test",
    );
    expect(result.ok).toBe(false);
  });

  it("dry-run refuses for the production origin", () => {
    const result = checkDispatchMode(
      { DISPATCH_MODE: "dry-run", GH_REF: "feat/ts-migration" },
      PRODUCTION_ORIGIN,
    );
    expect(result.ok).toBe(false);
  });

  it("dry-run succeeds off a non-production ref and origin", () => {
    const result = checkDispatchMode(
      { DISPATCH_MODE: "dry-run", GH_REF: "feat/ts-migration" },
      "https://preview.test",
    );
    expect(result).toEqual({ ok: true, mode: "dry-run" });
  });

  it("dry-run succeeds when no origin was resolved (e.g. test harness)", () => {
    const result = checkDispatchMode(
      { DISPATCH_MODE: "dry-run", GH_REF: "feat/ts-migration" },
      undefined,
    );
    expect(result).toEqual({ ok: true, mode: "dry-run" });
  });

  // p5-plan.md §2 A6: PRODUCTION_ORIGINS grows to include core's
  // PUBLIC_ORIGIN (the future Cloudflare Pages origin), still a
  // placeholder value today -- asserted by shape (imported, not
  // hard-coded) so this stays correct once the real origin lands.
  it("PRODUCTION_ORIGINS includes both the GitHub Pages origin and core's PUBLIC_ORIGIN", () => {
    expect(PRODUCTION_ORIGINS).toContain(PRODUCTION_ORIGIN);
    expect(PRODUCTION_ORIGINS).toContain(PUBLIC_ORIGIN);
  });

  it("dry-run refuses for core's PUBLIC_ORIGIN, whatever its current value is", () => {
    const result = checkDispatchMode(
      { DISPATCH_MODE: "dry-run", GH_REF: "feat/ts-migration" },
      PUBLIC_ORIGIN,
    );
    expect(result.ok).toBe(false);
  });
});
