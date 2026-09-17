import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../../..");
const indexPath = resolve(root, "docs/search-index-v2.json");
const fixturePath = resolve(__dirname, "../fixtures/search-v2/frozen-eval-v1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const indexBytes = readFileSync(indexPath);
const rows = JSON.parse(indexBytes);

await import(`${pathToFileURL(resolve(root, "docs/assets/search.js")).href}?frozen-eval=v1`);
const core = globalThis.PaperPilotSearchCore;
core.validateIndex(rows);

assert.equal(createHash("sha256").update(indexBytes).digest("hex"), fixture.frozen_corpus.index_sha256);
assert.equal(rows.length, fixture.frozen_corpus.row_count);
assert.equal(indexBytes.length, fixture.frozen_corpus.index_bytes);

const canonicalIds = [];
const shardDir = resolve(root, "docs/search-paper-ids-v1");
let shardBytes = 0;
for (const name of readdirSync(shardDir).filter((name) => name.endsWith(".json")).sort()) {
  const path = resolve(shardDir, name);
  const bytes = readFileSync(path);
  shardBytes += bytes.length;
  const shard = JSON.parse(bytes);
  shard.paper_ids.forEach((id, offset) => { canonicalIds[shard.start + offset] = id; });
}
assert.equal(canonicalIds.length, rows.length);

const started = performance.now();
let rankLatencyMs = 0;
const results = fixture.queries.map((entry) => {
  const catalogIds = new Set(entry.catalog_sources.flatMap((slug) => {
    const papers = JSON.parse(readFileSync(resolve(root, `docs/${slug}/papers.json`), "utf8"));
    return papers.map((paper) => paper.paper_id);
  }));
  entry.relevant_ids.forEach((id) => {
    assert.ok(catalogIds.has(id), `${entry.id}: frozen expected ID must come from a named catalog`);
  });
  const rankStarted = performance.now();
  const hits = core.rankResults(rows, entry.query, entry.filters);
  rankLatencyMs += performance.now() - rankStarted;
  const returned = hits.slice(0, entry.pool_k).map((hit) => canonicalIds[hit.row[2]]);
  const relevant = new Set(entry.relevant_ids);
  const relevantReturned = returned.filter((id) => relevant.has(id)).length;
  if (entry.expect_zero) {
    assert.equal(returned.length, 0, `${entry.id} must remain an explicit zero-result case`);
    if (entry.unsupported) {
      return { id: entry.id, returned: 0, scored: false, unsupported: true, observed_zero_result: true };
    }
    return { id: entry.id, returned: 0, scored: false, zero_result_pass: true };
  }
  const firstRelevant = returned.findIndex((id) => relevant.has(id));
  assert.ok(firstRelevant >= 0, `${entry.id} must retrieve at least one frozen relevant ID`);
  return {
    id: entry.id,
    returned: returned.length,
    scored: true,
    precision_at_k: relevantReturned / returned.length,
    recall_at_k: relevantReturned / relevant.size,
    reciprocal_rank: 1 / (firstRelevant + 1),
    facet_precision: entry.id === "facets"
      ? hits.slice(0, entry.pool_k).filter((hit) => core.rowMatchesFacets(hit.row, entry.filters)).length /
        Math.min(entry.pool_k, hits.length)
      : null,
  };
});
const latencyMs = performance.now() - started;
const scored = results.filter((result) => result.scored);
const mean = (field) => scored.reduce((sum, result) => sum + result[field], 0) / scored.length;
const duplicateCount = fixture.queries.reduce((total, entry) => {
  const ids = core.rankResults(rows, entry.query, entry.filters).slice(0, entry.pool_k)
    .map((hit) => canonicalIds[hit.row[2]]);
  return total + ids.length - new Set(ids).size;
}, 0);
const returnedCount = results.reduce((total, result) => total + result.returned, 0);
const report = {
  corpus: {
    rows: rows.length,
    index_sha256: fixture.frozen_corpus.index_sha256,
    index_bytes: indexBytes.length,
    id_shard_bytes: shardBytes,
    total_search_asset_bytes: indexBytes.length + shardBytes,
  },
  metrics: {
    precision_at_k: mean("precision_at_k"),
    recall_at_k: mean("recall_at_k"),
    mrr: mean("reciprocal_rank"),
    facet_precision: results.find((result) => result.id === "facets").facet_precision,
    duplicate_id_rate: returnedCount ? duplicateCount / returnedCount : 0,
    source_coverage: `${new Set(rows.map((row) => row[1])).size}/${fixture.frozen_corpus.conference_count}`,
    api_cost_usd: 0,
    scored_queries: scored.length,
    unscored_zero_result_cases: results.length - scored.length,
    unsupported_queries: results.filter((result) => result.unsupported).map((result) => result.id),
    rank_latency_ms: rankLatencyMs,
    evaluation_total_latency_ms: latencyMs,
    latency_condition: `${process.platform}/${process.arch} Node ${process.version}; warm local parsed index; ${fixture.queries.length} serial queries; ranking time excludes fixture/catalog I/O`,
    judgement_scope: fixture.metric_contract.judgement_scope,
  },
  queries: results,
};

assert.equal(report.metrics.facet_precision, 1);
assert.equal(report.metrics.duplicate_id_rate, 0);
assert.equal(report.metrics.source_coverage, "10/10");
assert.equal(report.metrics.api_cost_usd, 0);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
