import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(here, "../../../docs/assets/catalog-core.js");
await import(`${pathToFileURL(corePath).href}?contract=slide-request-v1`);

const core = globalThis.PaperPilotCatalogCore;
const paperId = "a".repeat(40);
const requestId = `paper-slide-${"A".repeat(22)}`;
const statusCap = `psc_${"B".repeat(43)}`;
const deckId = `sd1-${"c".repeat(64)}`;
const deckPath = `/automatic-paper-search/paper-slides-v1/decks/${deckId}/${"d".repeat(64)}-${"e".repeat(64)}.html`;
const otherDeckId = `sd1-${"f".repeat(64)}`;
const otherDeckPath = `/automatic-paper-search/paper-slides-v1/decks/${otherDeckId}/${"d".repeat(64)}-${"e".repeat(64)}.html`;
const apiBase = "https://slides-api.example.test";

assert.equal(core.PAPER_SLIDE_API_BASE, null, "production request plane stays disabled until configured");
assert.equal(core.parsePaperSlideApiBase(null), null);
assert.equal(core.parsePaperSlideApiBase("http://slides.example"), null);
assert.equal(core.parsePaperSlideApiBase("https://slides.example/path"), null);
assert.equal(core.parsePaperSlideApiBase(`${apiBase}/`), apiBase);

const paper = { paper_id: paperId, pdf_url: "https://arxiv.org/pdf/1", abstract: "" };
assert.equal(core.paperSlideEligibility(paper, "not_published", apiBase).state, "requestable");
assert.equal(
  core.paperSlideEligibility({ ...paper, pdf_url: "javascript:bad" }, "not_published", apiBase).state,
  "unavailable",
);
assert.equal(
  core.paperSlideEligibility({ ...paper, pdf_url: "", abstract: "  useful abstract  " }, "not_published", apiBase).state,
  "requestable",
);
assert.equal(core.paperSlideEligibility(paper, "unverified", apiBase).state, "unavailable");
assert.equal(core.paperSlideEligibility(paper, "not_published", null).state, "unavailable");
assert.equal(core.paperSlideEligibility(paper, "published", null).state, "published");

const created = {
  ok: true,
  status: "queued",
  request_id: requestId,
  status_cap: statusCap,
  paper_id: paperId,
  deduplicated: false,
};
assert.deepEqual(core.parsePaperSlideRequestResponse(created, paperId), created);
assert.equal(
  core.parsePaperSlideRequestResponse(created, paperId, {
    request_id: requestId,
    status_cap: `psc_${"C".repeat(43)}`,
  }),
  null,
  "a request response cannot replay the prior request identity",
);
for (const malformed of [
  { ...created, server_message: statusCap },
  { ...created, request_id: `${requestId}\n` },
  { ...created, status_cap: requestId },
  { ...created, paper_id: "b".repeat(40) },
  { ...created, status: "running" },
  { ...created, deduplicated: "false" },
]) {
  assert.equal(core.parsePaperSlideRequestResponse(malformed, paperId), null);
}

function status(overrides = {}) {
  return {
    ok: true,
    request_id: requestId,
    paper_id: paperId,
    status: "running",
    phase: "extracting",
    coverage: null,
    deck_id: null,
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    message_code: "PAPER_SLIDE_EXTRACTING",
    updated_at: "2026-09-04T01:02:03Z",
    ...overrides,
  };
}
assert.equal(core.parsePaperSlideStatusResponse(status(), requestId, paperId).status, "running");
assert.equal(core.paperSlideDisplayState("running"), "generating");
assert.equal(core.paperSlideDisplayState("validating"), "generating");
assert.equal(core.paperSlideDisplayState("publishing"), "generating");
assert.equal(core.paperSlideDisplayState("rejected"), "failed");
assert.equal(core.paperSlideStatusMayFollow("queued", "publishing"), true, "polling may skip states");
assert.equal(core.paperSlideStatusMayFollow("publishing", "running"), false, "status cannot regress");
assert.equal(core.paperSlideStatusMayFollow("published", "failed"), false, "terminal status is final");

const runningEarlier = status({ phase: "generating", message_code: "PAPER_SLIDE_GENERATING" });
const runningLater = status({
  phase: "generating",
  message_code: "PAPER_SLIDE_GENERATING",
  updated_at: "2026-09-04T01:02:04Z",
});
assert.equal(core.paperSlideStatusResponseMayFollow(runningEarlier, runningLater), true);
assert.equal(core.paperSlideStatusResponseMayFollow(runningEarlier, status({
  phase: "fetching",
  message_code: "PAPER_SLIDE_FETCHING",
  updated_at: "2026-09-04T01:02:04Z",
})), false, "a same-status phase cannot regress");
assert.equal(core.paperSlideStatusResponseMayFollow(runningLater, runningEarlier), false,
  "updated_at cannot move backwards");

const published = status({
  status: "published",
  phase: null,
  coverage: "full_text",
  deck_id: deckId,
  public_url: deckPath,
  message_code: "PAPER_SLIDE_PUBLISHED",
});
assert.equal(core.parsePaperSlideStatusResponse(published, requestId, paperId).public_url, deckPath);
const awaitingReview = status({
  status: "awaiting_review",
  phase: "awaiting_review",
  coverage: "full_text",
  deck_id: deckId,
  message_code: "PAPER_SLIDE_AWAITING_REVIEW",
});
assert.equal(core.paperSlideStatusResponseMayFollow(awaitingReview, published), true);
assert.equal(core.paperSlideStatusResponseMayFollow(awaitingReview, {
  ...published,
  deck_id: otherDeckId,
  public_url: otherDeckPath,
}), false, "validated deck identity cannot change across success states");
assert.equal(
  core.publicSlideEntryMatchesStatus({ paper_id: paperId, deck_id: deckId, coverage: "full_text", deck_path: deckPath }, published),
  true,
);
assert.equal(
  core.publicSlideEntryMatchesStatus({ paper_id: paperId, deck_id: deckId, coverage: "full_text", deck_path: `${deckPath}?stale=1` }, published),
  false,
  "published link requires the exact reviewed path",
);

for (const malformed of [
  { ...status(), message: statusCap },
  { ...status(), request_id: `${requestId}\n` },
  { ...status(), paper_id: "b".repeat(40) },
  { ...status(), status: "generating" },
  { ...status(), phase: "50%" },
  { ...status(), message_code: "PAPER_SLIDE_EXTRACTING_LOOKALIKE" },
  { ...status(), public_url: statusCap },
  { ...status(), retryable: true },
  { ...published, public_url: "https://evil.example/deck.html" },
  { ...published, public_url: otherDeckPath },
  { ...published, deck_id: null },
]) {
  assert.equal(core.parsePaperSlideStatusResponse(malformed, requestId, paperId), null);
}

const failed = status({
  status: "failed",
  phase: null,
  message_code: "PAPER_SLIDE_FAILED",
  retryable: true,
});
assert.equal(core.parsePaperSlideStatusResponse(failed, requestId, paperId).retryable, true);

const stored = core.serializePaperSlideSession({
  paper_id: paperId,
  request_id: requestId,
  status_cap: statusCap,
});
assert.equal(stored.includes(statusCap), true);
assert.deepEqual(core.parsePaperSlideSession(stored, paperId), {
  paper_id: paperId,
  request_id: requestId,
  status_cap: statusCap,
});
assert.equal(core.parsePaperSlideSession(`${stored}\n`, paperId), null, "storage is canonical and closed");
assert.equal(core.parsePaperSlideSession(JSON.stringify({ ...JSON.parse(stored), extra: statusCap }), paperId), null);
assert.equal(core.serializePaperSlideSession({
  paper_id: paperId,
  request_id: requestId,
  status_cap: requestId,
}), null, "request identity cannot be reused as the status capability");
assert.equal(core.parsePaperSlideSession(JSON.stringify({
  paper_id: paperId,
  request_id: requestId,
  status_cap: requestId,
}), paperId), null);

assert.deepEqual(
  Array.from({ length: 9 }, (_, attempt) => core.paperSlidePollDelay(attempt)),
  [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000],
);

console.log("catalog slide request/status core contract passed");
