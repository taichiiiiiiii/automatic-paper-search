import { describe, expect, it } from "vitest";
import {
  conferenceHref,
  deriveLandingConferenceState,
  PLACEHOLDER_COUNTS,
  sortConferenceRows,
  UNKNOWN_COUNTS,
  venueLabel,
} from "../../lib/landing";

// Behavioural port of the numerals/list logic pinned by
// paperpilot/tests/test_landing_s0.py (SCR-09/SCR-10):
//   - test_landing_numerals_degrade_on_conferences_fetch_failure
//   - test_landing_numerals_degrade_on_empty_or_non_array_conferences
// Those tests grepped docs/assets/landing.js's source for specific
// branches; here the behaviour itself (not the source text) is tested
// against lib/landing.ts's pure port.

describe("deriveLandingConferenceState", () => {
  it("falls back to 複数/多数 on a non-array response", () => {
    expect(deriveLandingConferenceState(null)).toEqual({ kind: "unknown" });
    expect(deriveLandingConferenceState("not-an-array")).toEqual({ kind: "unknown" });
    expect(deriveLandingConferenceState({ oops: true })).toEqual({ kind: "unknown" });
  });

  it("falls back to 複数/多数 on an empty array", () => {
    expect(deriveLandingConferenceState([])).toEqual({ kind: "unknown" });
  });

  it("reports real counts, sorted by paper count desc then slug asc", () => {
    const state = deriveLandingConferenceState([
      { name: "iclr-2026", papers: 5 },
      { name: "cvpr-2026", papers: 20 },
      { name: "aaai-2026", papers: 20 },
    ]);
    expect(state).toEqual({
      kind: "loaded",
      n: "3",
      m: "45",
      list: [
        { name: "aaai-2026", papers: 20 },
        { name: "cvpr-2026", papers: 20 },
        { name: "iclr-2026", papers: 5 },
      ],
      label: "学会から探す (3)",
    });
  });

  it("filters out rows with an unsafe slug or a non-safe-integer/negative paper count (SCR-09)", () => {
    const state = deriveLandingConferenceState([
      { name: "cvpr-2026", papers: 20 },
      { name: "../traversal", papers: 5 },
      { name: "bad-count", papers: -1 },
      { name: "bad-float", papers: 1.5 },
      { name: "no-papers" },
    ]);
    expect(state).toEqual({
      kind: "loaded",
      n: "1",
      m: "20",
      list: [{ name: "cvpr-2026", papers: 20 }],
      label: "学会から探す (1)",
    });
  });

  it("reports 0/0 (not a 複数/多数 fallback) when every row in a non-empty array is invalid", () => {
    // This mirrors docs/assets/landing.js exactly: the fallback only
    // triggers on a non-array / zero-length response, never on a
    // non-empty array whose rows all fail the per-row filter.
    const state = deriveLandingConferenceState([{ name: "../bad", papers: -1 }]);
    expect(state).toEqual({ kind: "loaded", n: "0", m: "0", list: [], label: "学会から探す (0)" });
  });
});

describe("PLACEHOLDER_COUNTS / UNKNOWN_COUNTS", () => {
  it("are the exact static numerals from docs/index.html", () => {
    expect(PLACEHOLDER_COUNTS).toEqual({ n: "10", m: "28,000" });
  });

  it("are the exact 複数/多数 fallback", () => {
    expect(UNKNOWN_COUNTS).toEqual({ n: "複数", m: "多数" });
  });
});

describe("venueLabel", () => {
  it("splits <slug>-<year> into '<SLUG> <year>'", () => {
    expect(venueLabel("cvpr-2026")).toBe("CVPR 2026");
    expect(venueLabel("eccv-2024")).toBe("ECCV 2024");
  });

  it("falls back to an uppercased slug with no year suffix", () => {
    expect(venueLabel("robotics")).toBe("ROBOTICS");
  });
});

describe("conferenceHref", () => {
  it("percent-encodes the slug (SCR-09)", () => {
    expect(conferenceHref("cvpr-2026")).toBe("/cvpr-2026/");
    expect(conferenceHref("../evil")).toBe(`/${encodeURIComponent("../evil")}/`);
    expect(conferenceHref("../evil")).not.toContain("../");
  });
});

describe("sortConferenceRows", () => {
  it("does not mutate its input", () => {
    const input = [
      { name: "b-2026", papers: 1 },
      { name: "a-2026", papers: 2 },
    ];
    const sorted = sortConferenceRows(input);
    expect(sorted).not.toBe(input);
    expect(input).toEqual([
      { name: "b-2026", papers: 1 },
      { name: "a-2026", papers: 2 },
    ]);
  });
});
