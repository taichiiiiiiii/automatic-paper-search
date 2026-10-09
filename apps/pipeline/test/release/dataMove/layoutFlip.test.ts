import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { LAYOUT_MODE } from "@paperpilot/core/layout";
import { describe, expect, it, vi } from "vitest";
import {
  flipLayoutModeToLegacy,
  flipLayoutModeToP5,
  LayoutFlipError,
} from "../../../src/release/dataMove/layoutFlip.js";
import { LAYOUT_FIXTURE } from "./fixtures.js";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("flipLayoutModeToP5 / flipLayoutModeToLegacy", () => {
  it("flips the single literal and round-trips exactly", () => {
    const flipped = flipLayoutModeToP5(LAYOUT_FIXTURE);
    expect(flipped).toContain('LAYOUT_MODE: LayoutMode = "p5"');
    expect(flipped).not.toContain('LAYOUT_MODE: LayoutMode = "legacy"');
    // The type union itself still legitimately mentions "legacy".
    expect(flipped).toContain('type LayoutMode = "legacy" | "p5"');
    expect(flipLayoutModeToLegacy(flipped)).toBe(LAYOUT_FIXTURE);
  });

  it("RED: throws if the legacy literal is not found", () => {
    expect(() => flipLayoutModeToP5("export const X = 1;\n")).toThrow(LayoutFlipError);
  });

  it("RED: throws if the literal appears more than once", () => {
    const twice = LAYOUT_FIXTURE + LAYOUT_FIXTURE;
    expect(() => flipLayoutModeToP5(twice)).toThrow(LayoutFlipError);
  });

  it("RED: flipLayoutModeToLegacy throws against an already-legacy file", () => {
    expect(() => flipLayoutModeToLegacy(LAYOUT_FIXTURE)).toThrow(LayoutFlipError);
  });
});

/**
 * The real `packages/core/src/layout/index.ts` is read-only here, never
 * written. The test runs in both layouts and asserts the fact that holds
 * in the current one (review round 2, N1: a mode-gated skip reports
 * "skipped" after commit B, which the release no-skip gate rejects).
 * Legacy: exactly one legacy literal, so B's forward flip applies and a
 * reverse flip refuses. p5 (after B, including the p5 rehearsal clone):
 * exactly one p5 literal, so R-B's reverse flip applies and a second
 * forward flip refuses.
 */
describe("against the real repository's layout module (read-only)", () => {
  it("contains exactly one LAYOUT_MODE literal for the current layout, flippable only the other way", () => {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    }).trim();
    const text = readFileSync(`${root}/packages/core/src/layout/index.ts`, "utf-8");
    expect(["legacy", "p5"]).toContain(LAYOUT_MODE);
    if (LAYOUT_MODE === "legacy") {
      expect(flipLayoutModeToLegacy(flipLayoutModeToP5(text))).toBe(text);
      expect(() => flipLayoutModeToLegacy(text)).toThrow(LayoutFlipError);
    } else {
      expect(flipLayoutModeToP5(flipLayoutModeToLegacy(text))).toBe(text);
      expect(() => flipLayoutModeToP5(text)).toThrow(LayoutFlipError);
    }
  });
});
