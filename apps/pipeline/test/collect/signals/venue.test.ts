/**
 * Port of `paperpilot/tests/test_venue_signal.py` and
 * `test_venue_stress.py`.
 */
import { describe, expect, it } from "vitest";
import { createPaper } from "../../../src/collect/model/paper.js";
import { VenueSignal } from "../../../src/collect/signals/venue.js";

function samplePaper(overrides: Partial<Parameters<typeof createPaper>[0]> = {}) {
  return createPaper({
    title: "Retrieval-Augmented Generation for Language Models",
    authors: ["Alice", "Bob"],
    abstract: "We propose a retrieval augmented method for LLMs.",
    url: "https://arxiv.org/abs/2604.01234",
    publishedDate: "2026-03-29",
    source: "arxiv",
    arxivId: "2604.01234",
    categories: ["cs.CL", "cs.LG"],
    comment: "Accepted at ICLR 2026",
    ...overrides,
  });
}

describe("test_classify", () => {
  it.each([
    ["Accepted at ICLR 2026", "ICLR", 1, 100],
    ["Accepted to NeurIPS 2025", "NEURIPS", 1, 100],
    ["To appear at ACL 2026", "ACL", 2, 80],
    ["Published in CVPR 2025", "CVPR", 2, 80],
    ["Accepted at EMNLP 2025 (Main)", "EMNLP", 2, 80],
    ["Accepted at AISTATS 2026", "AISTATS", 3, 60],
    ["Accepted at ICLR 2026 Workshop", "ICLR Workshop", 4, 30],
    ["Published in NeurIPS 2025 Workshop on Safety", "NEURIPS Workshop", 4, 30],
    ["Some random workshop paper", "Workshop", 4, 30],
    ["", null, 0, 0],
    ["20 pages, 3 figures", null, 0, 0],
  ] as const)("%s", (comment, expectedVenue, expectedTier, expectedScore) => {
    const [venue, tier, score] = VenueSignal.classify(comment);
    expect(venue).toBe(expectedVenue);
    expect(tier).toBe(expectedTier);
    expect(score).toBe(expectedScore);
  });
});

it("test_enrich_one_sets_fields", () => {
  const signal = new VenueSignal({ enabled: true });
  const enriched = signal.enrichOne(samplePaper());
  expect(enriched.venue).toBe("ICLR");
  expect(enriched.venueTier).toBe(1);
  expect(enriched.venueScore).toBe(100.0);
});

it("test_enrich_one_no_comment", () => {
  const signal = new VenueSignal({ enabled: true });
  const enriched = signal.enrichOne(samplePaper({ comment: null }));
  expect(enriched.venue).toBeNull();
  expect(enriched.venueTier).toBe(0);
});

// ---- test_venue_stress.py ----

const POSITIVE_CASES: readonly (readonly [string, string])[] = [
  ["Accepted at ICLR 2026", "ICLR"],
  ["Accepted to ICLR 2026", "ICLR"],
  ["To appear at ICLR 2026", "ICLR"],
  ["To appear in ICLR 2025", "ICLR"],
  ["Published at ICLR 2025", "ICLR"],
  ["Published in ICLR 2025 (Spotlight)", "ICLR"],
  ["Accepted at ICLR 2026. 24 pages, 8 figures.", "ICLR"],
  ["Accepted by ICLR 2026", "ICLR"],
  ["Accepted at NeurIPS 2025", "NEURIPS"],
  ["Accepted at NeurIPS 2025 (Oral)", "NEURIPS"],
  ["Accepted to NeurIPS 2025 main conference track", "NEURIPS"],
  ["To appear at NeurIPS 2024", "NEURIPS"],
  ["Accepted at NIPS 2016", "NIPS"],
  ["Published in NeurIPS 2024", "NEURIPS"],
  ["Accepted at ICML 2025", "ICML"],
  ["To appear at ICML 2024 (Long Talk)", "ICML"],
  ["Accepted to ICML 2026 (Oral)", "ICML"],
  ["Published at ICML 2023", "ICML"],
  ["Accepted at ACL 2024", "ACL"],
  ["Accepted to ACL 2024 Main Conference", "ACL"],
  ["To appear at ACL 2025", "ACL"],
  ["Accepted at EMNLP 2024", "EMNLP"],
  ["Accepted to EMNLP 2024 Findings", "EMNLP"],
  ["Accepted at EMNLP 2025", "EMNLP"],
  ["Accepted at NAACL 2024", "NAACL"],
  ["Accepted to NAACL 2024", "NAACL"],
  ["Accepted at CVPR 2025", "CVPR"],
  ["Accepted to CVPR 2025 (Highlight)", "CVPR"],
  ["To appear at CVPR 2026", "CVPR"],
  ["Accepted at ICCV 2023", "ICCV"],
  ["Accepted at ICCV 2025", "ICCV"],
  ["Accepted at ECCV 2024", "ECCV"],
  ["Accepted to ECCV 2024", "ECCV"],
  ["Accepted at AAAI 2025", "AAAI"],
  ["Accepted to AAAI 2025", "AAAI"],
  ["Accepted at IJCAI 2024", "IJCAI"],
  ["Accepted at KDD 2024", "KDD"],
  ["Accepted at WWW 2024", "WWW"],
  ["Accepted at AISTATS 2025", "AISTATS"],
  ["To appear at AISTATS 2024", "AISTATS"],
  ["Accepted at ICLR 2026 Workshop on LLMs", "Workshop"],
  ["Published in NeurIPS 2025 Workshop on Safety", "Workshop"],
  ["Accepted to ICML 2025 Workshop", "Workshop"],
  ["Workshop paper at ACL 2024", "Workshop"],
  ["NeurIPS 2024 Workshop on Scaling Laws", "Workshop"],
  ["CVPR 2024 Workshop on Embodied AI", "Workshop"],
  ["Accepted at the ICLR 2026 conference", "ICLR"],
  ["Accepted to the ACL 2024 main track", "ACL"],
  ["Published in the EMNLP 2024 proceedings", "EMNLP"],
  ["Accepted by the AAAI 2025 conference", "AAAI"],
];

const NEGATIVE_CASES: readonly string[] = [
  "",
  "20 pages, 3 figures",
  "Preprint",
  "Work in progress",
  "Draft version",
  "Updated with new experiments",
  "Source code at github.com/user/repo",
  "Extended version of a previous paper",
  "Submitted to the Journal of Some Topic",
  "NeurIPS was great this year",
  "ICLR submission deadline passed",
  "v2: added baseline comparisons",
];

describe("test_positive_detection", () => {
  it.each(POSITIVE_CASES)("%s -> %s", (comment, expected) => {
    const [venue, tier, score] = VenueSignal.classify(comment);
    if (expected === "Workshop") {
      expect(venue).not.toBeNull();
      expect((venue as string).toLowerCase()).toContain("workshop");
      expect(tier).toBe(4);
      expect(score).toBe(30);
    } else {
      expect(venue).toBe(expected);
      expect(tier).toBeGreaterThanOrEqual(1);
      expect(score).toBeGreaterThanOrEqual(60);
    }
  });
});

describe("test_negative_detection", () => {
  it.each(NEGATIVE_CASES)("%s", (comment) => {
    const [venue, tier, score] = VenueSignal.classify(comment);
    expect(venue).toBeNull();
    expect(tier).toBe(0);
    expect(score).toBe(0);
  });
});

it("test_detection_rate_above_95_percent", () => {
  let correct = 0;
  for (const [comment, expected] of POSITIVE_CASES) {
    const [venue] = VenueSignal.classify(comment);
    if (expected === "Workshop") {
      if (venue?.toLowerCase().includes("workshop")) correct += 1;
    } else if (venue === expected) {
      correct += 1;
    }
  }
  const rate = correct / POSITIVE_CASES.length;
  expect(rate).toBeGreaterThanOrEqual(0.95);
});
