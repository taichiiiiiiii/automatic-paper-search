// Ported 1:1 from worker/run-match.test.mjs.

import { describe, expect, it } from "vitest";
import { pickMatchingRun } from "../../src/lib/run-match.js";

function mkRun(theme: string, requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    conclusion: "success",
    html_url: `https://x/${requestId}`,
    created_at: "2026-08-30T00:00:00Z",
    run_started_at: "2026-08-30T00:00:05Z",
    display_title: `theme-on-demand: ${theme} / ${requestId}`,
    ...overrides,
  };
}

const ID_A = "theme-123e4567-e89b-42d3-a456-426614174000";
const ID_B = "theme-123e4567-e89b-42d3-b456-426614174001";

describe("pickMatchingRun", () => {
  it("returns null when runs is missing", () => {
    expect(pickMatchingRun(undefined, ID_A)).toBeNull();
    expect(pickMatchingRun(null, ID_A)).toBeNull();
  });
  it("returns null when runs is not an array", () => {
    expect(pickMatchingRun({}, ID_A)).toBeNull();
    expect(pickMatchingRun("runs", ID_A)).toBeNull();
  });
  it("rejects blank, malformed, and non-string IDs", () => {
    expect(pickMatchingRun([mkRun("RAG", ID_A)], "")).toBeNull();
    expect(pickMatchingRun([mkRun("RAG", ID_A)], "theme-bad")).toBeNull();
    expect(pickMatchingRun([mkRun("RAG", ID_A)], null)).toBeNull();
  });
  it("matches an exact request-ID suffix", () => {
    expect(pickMatchingRun([mkRun("RAG", ID_A)], ID_A)?.html_url).toBe(`https://x/${ID_A}`);
  });
  it("same theme with a different ID does not match", () => {
    expect(pickMatchingRun([mkRun("RAG", ID_B)], ID_A)).toBeNull();
  });
  it("different theme with the requested ID still correlates", () => {
    expect(pickMatchingRun([mkRun("Vision Transformer", ID_A)], ID_A)?.display_title).toBe(
      `theme-on-demand: Vision Transformer / ${ID_A}`,
    );
  });
  it("returns the first matching run in API order", () => {
    const runs = [
      mkRun("RAG", ID_A, { html_url: "https://x/new" }),
      mkRun("RAG", ID_A, { html_url: "https://x/old" }),
    ];
    expect(pickMatchingRun(runs, ID_A)?.html_url).toBe("https://x/new");
  });
  it("does not match an ID appearing before the suffix", () => {
    const run = mkRun("RAG", ID_B, { display_title: `theme-on-demand: ${ID_A} / ${ID_B}` });
    expect(pickMatchingRun([run], ID_A)).toBeNull();
  });
  it("ignores a non-string display_title", () => {
    const bad = { ...mkRun("RAG", ID_A), display_title: null };
    expect(pickMatchingRun([bad, mkRun("RAG", ID_A)], ID_A)?.html_url).toBe(`https://x/${ID_A}`);
  });
  it("does not trim or case-normalise opaque IDs", () => {
    expect(pickMatchingRun([mkRun("RAG", ID_A)], ` ${ID_A}`)).toBeNull();
    expect(pickMatchingRun([mkRun("RAG", ID_A)], ID_A.toUpperCase())).toBeNull();
  });
  it("returns only the explicit public run fields", () => {
    const run = mkRun("RAG", ID_A, {
      status: "in_progress",
      conclusion: null,
      head_sha: "must-not-leak",
      actor: { login: "must-not-leak" },
    });
    const match = pickMatchingRun([run], ID_A);
    expect(match?.status).toBe("in_progress");
    expect(match?.conclusion).toBeNull();
    expect(Object.hasOwn(match as object, "head_sha")).toBe(false);
    expect(Object.hasOwn(match as object, "actor")).toBe(false);
  });
});
