import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  flipLayoutModeToLegacy,
  flipLayoutModeToP5,
  LayoutFlipError,
} from "../../../src/release/dataMove/layoutFlip.js";
import { LAYOUT_FIXTURE } from "./fixtures.js";

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

/** The real `packages/core/src/layout/index.ts` is read-only here, never written. */
describe("against the real repository's layout module (read-only)", () => {
  it("contains exactly one legacy LAYOUT_MODE literal today", () => {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    }).trim();
    const text = readFileSync(`${root}/packages/core/src/layout/index.ts`, "utf-8");
    expect(() => flipLayoutModeToP5(text)).not.toThrow();
  });
});
