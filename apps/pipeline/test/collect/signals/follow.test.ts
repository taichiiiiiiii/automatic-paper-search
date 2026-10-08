/**
 * Port of `paperpilot/tests/test_follow_signal.py`.
 */
import { expect, it } from "vitest";
import { createPaper } from "../../../src/collect/model/paper.js";
import { FollowSignal } from "../../../src/collect/signals/follow.js";

function paper(authors: string[] = ["Alice"], affiliations: string[] = [], suffix = "1") {
  return createPaper({
    title: `Paper ${suffix}`,
    authors,
    abstract: "abs",
    url: `http://x/${suffix}`,
    publishedDate: "2026-01-01",
    source: "arxiv",
    arxivId: `2604.${suffix}`,
    affiliations,
  });
}

it("test_author_match_scores_100", () => {
  const sig = new FollowSignal({ enabled: true }, ["Yann LeCun"], []);
  const p = sig.enrichOne(paper(["Yann LeCun", "Alice"]));
  expect(p.followScore).toBe(100.0);
  expect(p.followReason).toBe("followed_author");
});

it("test_org_match_scores_50", () => {
  const sig = new FollowSignal({ enabled: true }, [], ["OpenAI"]);
  const p = sig.enrichOne(paper(["Random"], ["OpenAI", "Stanford"]));
  expect(p.followScore).toBe(50.0);
  expect(p.followReason).toBe("followed_org");
});

it("test_author_wins_over_org", () => {
  const sig = new FollowSignal({ enabled: true }, ["Yann LeCun"], ["Meta"]);
  const p = sig.enrichOne(paper(["Yann LeCun"], ["Meta"]));
  expect(p.followScore).toBe(100.0);
  expect(p.followReason).toBe("followed_author");
});

it("test_no_match_is_zero", () => {
  const sig = new FollowSignal({ enabled: true }, ["Someone"], ["Somewhere"]);
  const p = sig.enrichOne(paper(["Random"], ["Other U"]));
  expect(p.followScore).toBe(0.0);
  expect(p.followReason).toBeNull();
});

it("test_case_insensitive_author_match", () => {
  const sig = new FollowSignal({ enabled: true }, ["yann lecun"], []);
  expect(sig.enrichOne(paper(["Yann LeCun"])).followScore).toBe(100.0);
});

it("test_whitespace_insensitive_author_match", () => {
  const sig = new FollowSignal({ enabled: true }, ["Yann  LeCun"], []);
  expect(sig.enrichOne(paper(["Yann LeCun"])).followScore).toBe(100.0);
});

it("test_partial_org_substring_matches", () => {
  const sig = new FollowSignal({ enabled: true }, [], ["Meta"]);
  const p = sig.enrichOne(paper(["X"], ["Meta AI Research, NY"]));
  expect(p.followScore).toBe(50.0);
});

it("test_empty_watchlists_signal_is_noop", () => {
  const sig = new FollowSignal({ enabled: true }, [], []);
  const p = sig.enrichOne(paper(["Yann LeCun"], ["Meta"]));
  expect(p.followScore).toBe(0.0);
  expect(p.followReason).toBeNull();
});

it("test_empty_paper_authors", () => {
  const sig = new FollowSignal({ enabled: true }, ["Alice"], []);
  expect(sig.enrichOne(paper([])).followScore).toBe(0.0);
});

it("test_signal_name", () => {
  const sig = new FollowSignal({ enabled: true }, [], []);
  expect(sig.name).toBe("follow");
});

it("test_enrich_batch_handles_multiple_papers", () => {
  const sig = new FollowSignal({ enabled: true }, ["Alice"], []);
  const papers = [
    paper(["Alice"], [], "1"),
    paper(["Bob"], [], "2"),
    paper(["Carol", "Alice"], [], "3"),
  ];
  const out = sig.enrichBatch(papers) as ReturnType<typeof paper>[];
  expect(out[0]?.followScore).toBe(100.0);
  expect(out[1]?.followScore).toBe(0.0);
  expect(out[2]?.followScore).toBe(100.0);
});
