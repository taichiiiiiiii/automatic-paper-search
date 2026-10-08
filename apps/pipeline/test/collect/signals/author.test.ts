/**
 * Port of `paperpilot/tests/test_author_signal.py`.
 */
import { expect, it } from "vitest";
import type { FetchLike, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { createPaper } from "../../../src/collect/model/paper.js";
import { AuthorSignal } from "../../../src/collect/signals/author.js";

function resp(body: unknown): HttpResponseLike {
  return { status: 200, json: async () => body };
}
function respWithStatus(status: number): HttpResponseLike {
  return { status, json: async () => null };
}

function mk(aid: string | null, suffix: string) {
  return createPaper({
    title: `T${suffix}`,
    authors: ["A"],
    abstract: "a",
    url: `http://x/${suffix}`,
    publishedDate: "2026-01-01",
    source: "arxiv",
    arxivId: `2604.000${suffix}`,
    firstAuthorId: aid,
  });
}

function withFetch(fetchImpl: FetchLike): ConstructorParameters<typeof AuthorSignal>[1] {
  // `sleep` is a no-op so a 429/5xx response's real retry backoff doesn't
  // actually wait in tests.
  return { fetchImpl, sleep: async () => {} };
}

it("test_enrich_fills_h_index", async () => {
  const paper = mk("AID_1", "1");
  const payload = [{ authorId: "AID_1", hIndex: 25, name: "X" }];
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => resp(payload)),
  );
  const out = await sig.enrichBatch([paper]);
  expect(out[0]?.authorHIndex).toBe(25);
  expect(out[0]?.authorScore).toBe(50.0);
});

it("test_saturation_at_h_50", async () => {
  const paper = mk("AID_1", "1");
  const payload = [{ authorId: "AID_1", hIndex: 80, name: "X" }];
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => resp(payload)),
  );
  const out = await sig.enrichBatch([paper]);
  expect(out[0]?.authorScore).toBe(100.0);
});

it("test_paper_without_author_id_skipped", async () => {
  const paper = mk(null, "1");
  let called = false;
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => {
      called = true;
      return resp([]);
    }),
  );
  await sig.enrichBatch([paper]);
  expect(called).toBe(false);
  expect(sig.runFailures).toEqual([]);
});

it("test_batch_failure_is_recorded_on_the_run_channel", async () => {
  const paper = mk("AID_1", "1");
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => respWithStatus(429)),
  );
  const out = await sig.enrichBatch([paper]);
  expect(out[0]?.authorScore).toBe(0.0);
  expect(out[0]?.authorHIndex).toBe(0);
  expect(sig.runFailures.length).toBe(1);
  expect(sig.runFailures[0]).toContain("status=429");
  expect(sig.runFailures[0]).toContain("n=1");
});

it("test_short_batch_records_the_unanswered_tail", async () => {
  const p1 = mk("AID_1", "1");
  const p2 = mk("AID_2", "2");
  const payload = [{ authorId: "AID_1", hIndex: 20, name: "X" }];
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => resp(payload)),
  );
  const out = await sig.enrichBatch([p1, p2]);
  expect(out[0]?.authorHIndex).toBe(20);
  expect(out[0]?.authorScore).toBe(40.0);
  expect(out[1]?.authorScore).toBe(0.0);
  expect(sig.runFailures).toEqual(["batch answered 1 of 2 ids"]);
});

it("test_full_batch_leaves_the_channel_empty", async () => {
  const p1 = mk("AID_1", "1");
  const payload = [{ authorId: "AID_1", hIndex: null, name: "X" }];
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => resp(payload)),
  );
  const out = await sig.enrichBatch([p1]);
  expect(out[0]?.authorHIndex).toBe(0);
  expect(sig.runFailures).toEqual([]);
});

it("test_dedup_author_ids", async () => {
  const p1 = mk("AID_1", "1");
  const p2 = mk("AID_1", "2");
  const payload = [{ authorId: "AID_1", hIndex: 10, name: "X" }];
  let seenIds: unknown;
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async (_url, init) => {
      seenIds = JSON.parse(init.body as string).ids;
      return resp(payload);
    }),
  );
  const out = await sig.enrichBatch([p1, p2]);
  expect(seenIds).toEqual(["AID_1"]);
  expect(out[0]?.authorHIndex).toBe(10);
  expect(out[1]?.authorHIndex).toBe(10);
});

it("test_payload_missing_author_id_is_recorded_as_a_failure", async () => {
  const paper = mk("AID_1", "1");
  const payload = [{ name: "X", hIndex: 25 }];
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => resp(payload)),
  );
  const out = await sig.enrichBatch([paper]);
  expect(out[0]?.authorScore).toBe(0.0);
  expect(out[0]?.authorHIndex).toBe(0);
  expect(sig.runFailures).toEqual(["batch returned 1 of 1 entries without a usable authorId"]);
});

it("test_mixed_chunk_scores_the_good_entry_and_records_the_bad_one", async () => {
  const p1 = mk("AID_1", "1");
  const p2 = mk("AID_2", "2");
  const payload = [
    { authorId: "AID_1", hIndex: 20, name: "X" },
    { name: "Y", hIndex: 10 },
  ];
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => resp(payload)),
  );
  const out = await sig.enrichBatch([p1, p2]);
  expect(out[0]?.authorHIndex).toBe(20);
  expect(out[0]?.authorScore).toBe(40.0);
  expect(out[1]?.authorScore).toBe(0.0);
  expect(sig.runFailures).toEqual(["batch returned 1 of 2 entries without a usable authorId"]);
});

it("test_blank_and_non_string_author_ids_are_recorded_as_one_failure", async () => {
  const p1 = mk("AID_1", "1");
  const p2 = mk("AID_2", "2");
  const payload = [
    { authorId: " ", hIndex: 10 },
    { authorId: 123, hIndex: 10 },
  ];
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => resp(payload)),
  );
  const out = await sig.enrichBatch([p1, p2]);
  expect(out[0]?.authorScore).toBe(0.0);
  expect(out[1]?.authorScore).toBe(0.0);
  expect(sig.runFailures).toEqual(["batch returned 2 of 2 entries without a usable authorId"]);
});

it("test_null_entry_for_one_id_is_not_a_failure", async () => {
  const paper = mk("AID_1", "1");
  const payload = [null];
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => resp(payload)),
  );
  const out = await sig.enrichBatch([paper]);
  expect(out[0]?.authorScore).toBe(0.0);
  expect(out[0]?.authorHIndex).toBe(0);
  expect(sig.runFailures).toEqual([]);
});

it("test_missing_h_index_key_is_recorded_as_a_failure", async () => {
  const paper = mk("AID_1", "1");
  const payload = [{ authorId: "AID_1", name: "X" }];
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => resp(payload)),
  );
  const out = await sig.enrichBatch([paper]);
  expect(out[0]?.authorScore).toBe(0.0);
  expect(out[0]?.authorHIndex).toBe(0);
  expect(sig.runFailures).toEqual(["batch returned 1 of 1 entries without a usable hIndex"]);
});

it("test_explicit_null_h_index_stays_a_legitimate_zero", async () => {
  const paper = mk("AID_1", "1");
  const payload = [{ authorId: "AID_1", hIndex: null, name: "X" }];
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async () => resp(payload)),
  );
  const out = await sig.enrichBatch([paper]);
  expect(out[0]?.authorHIndex).toBe(0);
  expect(out[0]?.authorScore).toBe(0.0);
  expect(sig.runFailures).toEqual([]);
});

it("test_requested_fields_include_every_key_the_parser_reads", async () => {
  const paper = mk("AID_1", "1");
  const payload = [{ authorId: "AID_1", hIndex: 25, name: "X", citationCount: 100 }];
  let requestedFields = "";
  const sig = new AuthorSignal(
    { enabled: true },
    withFetch(async (url) => {
      requestedFields = new URL(url).searchParams.get("fields") ?? "";
      return resp(payload);
    }),
  );
  const out = await sig.enrichBatch([paper]);
  const requested = new Set(requestedFields.split(","));
  expect(requested.has("authorId")).toBe(true);
  expect(requested.has("hIndex")).toBe(true);
  expect(out[0]?.authorHIndex).toBe(25);
  expect(sig.runFailures).toEqual([]);
});
