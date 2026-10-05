import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { LAYOUT_MODE } from "@paperpilot/core/layout";
import { describe, expect, it } from "vitest";
import {
  applyLighthouseEdit,
  LighthouseEditError,
  reverseLighthouseEdit,
} from "../../../src/release/dataMove/lighthouseEdit.js";
import { LIGHTHOUSERC_FIXTURE } from "./fixtures.js";

describe("applyLighthouseEdit / reverseLighthouseEdit", () => {
  it("rewrites staticDistDir and every URL, round-trips exactly, and leaves everything else byte-identical", () => {
    const p5 = applyLighthouseEdit(LIGHTHOUSERC_FIXTURE);
    expect(p5).toContain('"staticDistDir": "./apps/web/out"');
    expect(p5).not.toContain('"staticDistDir": "./docs"');
    expect(p5).toContain('"http://localhost/"');
    expect(p5).toContain('"http://localhost/iclr-2026/"');
    expect(p5).toContain('"http://localhost/iclr-2026/lineage/"');
    expect(p5).toContain('"http://localhost/themes/"');
    expect(p5).not.toContain(".html");
    // Unrelated content (comment, assertions, upload target) untouched.
    expect(p5).toContain("Lighthouse CI config fixture.");
    expect(p5).toContain('"categories:performance": ["warn", { "minScore": 0.85 }]');
    expect(p5).toContain('"target": "temporary-public-storage"');
    expect(reverseLighthouseEdit(p5)).toBe(LIGHTHOUSERC_FIXTURE);
  });

  it("RED: throws if staticDistDir's legacy literal is not found", () => {
    expect(() => applyLighthouseEdit("{}\n")).toThrow(LighthouseEditError);
  });

  it("RED: throws if a legacy literal appears more than once", () => {
    // Make the staticDistDir literal itself appear twice.
    const doubled = `${LIGHTHOUSERC_FIXTURE}\n// "staticDistDir": "./docs"`;
    expect(() => applyLighthouseEdit(doubled)).toThrow(LighthouseEditError);
  });

  it("RED: reverseLighthouseEdit throws against an already-legacy file", () => {
    expect(() => reverseLighthouseEdit(LIGHTHOUSERC_FIXTURE)).toThrow(LighthouseEditError);
  });
});

/**
 * The real `.lighthouserc.json` is read-only here, never written. The test
 * runs in both layouts and asserts the fact that holds in the current one
 * (review round 2, N1: a mode-gated skip reports "skipped" after commit B,
 * which the release no-skip gate rejects). Legacy: each legacy literal
 * occurs exactly once, so B's rewrite applies and round-trips, and the
 * reverse refuses. p5 (after B): R-B's reverse applies and round-trips,
 * and a second forward rewrite refuses.
 */
describe("against the real repository's .lighthouserc.json (read-only)", () => {
  it("is rewritable in exactly the direction the current layout needs, and round-trips", () => {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    }).trim();
    const text = readFileSync(`${root}/.lighthouserc.json`, "utf-8");
    expect(["legacy", "p5"]).toContain(LAYOUT_MODE);
    if (LAYOUT_MODE === "legacy") {
      expect(reverseLighthouseEdit(applyLighthouseEdit(text))).toBe(text);
      expect(() => reverseLighthouseEdit(text)).toThrow(LighthouseEditError);
    } else {
      expect(applyLighthouseEdit(reverseLighthouseEdit(text))).toBe(text);
      expect(() => applyLighthouseEdit(text)).toThrow(LighthouseEditError);
    }
  });
});
