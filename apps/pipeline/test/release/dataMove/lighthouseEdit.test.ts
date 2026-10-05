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
 * The real `.lighthouserc.json` is read-only here, never written. Once
 * commit B's `apply` has actually rewritten the real file for p5
 * (including during this task's own p5-rehearsal, which applies that
 * same rewrite to a scratch clone), it no longer contains the legacy
 * literals -- an explicit `LAYOUT_MODE` check, not a mode branch on what
 * this test asserts, skips it there.
 */
describe("against the real repository's .lighthouserc.json (read-only)", () => {
  it.skipIf(LAYOUT_MODE !== "legacy")(
    "contains exactly one occurrence of each legacy literal today",
    () => {
      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
      }).trim();
      const text = readFileSync(`${root}/.lighthouserc.json`, "utf-8");
      expect(() => applyLighthouseEdit(text)).not.toThrow();
    },
  );
});
