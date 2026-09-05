import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const searchUrl = pathToFileURL(
  resolve(__dirname, "../../../docs/assets/search.js")
).href;

await import(`${searchUrl}?contract=v2`);
const core = globalThis.PaperPilotSearchCore;
assert.ok(core, "search.js must expose its dependency-free core for contract tests");

function row(title, ref, { authors = [], tags = [], year = 2026, type = "Poster" } = {}) {
  return [title, "iclr-2026", ref, authors, tags, year, type];
}

const valid = [
  row("Exact Paper", 0, { year: 2022 }),
  row("An Exact Paper Survey", 1, { year: 2026 }),
  row("Unrelated", 2, { authors: ["Exact Paper Group"], year: 2025 }),
  row("Also Unrelated", 3, { tags: ["exact paper"], year: 2024 }),
];
assert.equal(core.validateIndex(valid), valid);
assert.throws(
  () => core.validateIndex([row("Wrong ref", 8)]),
  /paper_ref/,
  "one invalid row must reject the entire index"
);

const ranked = core.rankResults(valid, " exact   paper ");
assert.deepEqual(
  ranked.map((hit) => hit.matchKind),
  ["exact-title", "title", "author", "tag"]
);
assert.deepEqual(ranked.map((hit) => hit.row[2]), [0, 1, 2, 3]);

const ties = core.rankResults([
  row("alpha old", 0, { year: 2023 }),
  row("alpha newest first", 1, { year: 2026 }),
  row("alpha newest second", 2, { year: 2026 }),
  row("alpha unknown", 3, { year: null }),
], "alpha");
assert.deepEqual(
  ties.map((hit) => hit.row[2]),
  [1, 2, 0, 3],
  "ties use year descending, then original ordinal"
);

const many = Array.from({ length: 41 }, (_, ref) => row(`paper ${ref}`, ref));
const manyHits = core.rankResults(many, "paper");
assert.equal(core.paginate(manyHits, 1, 20).items.length, 20);
assert.equal(core.paginate(manyHits, 2, 20).items[0].row[2], 20);
assert.equal(core.paginate(manyHits, 3, 20).items[0].row[2], 40);

assert.equal(core.blockFile(0), "search-paper-ids-v1/0000.json");
assert.equal(core.blockFile(511), "search-paper-ids-v1/0001.json");
assert.throws(
  () => core.validateIdBlock({
    schema_version: "search-paper-ids-v1",
    block: 1,
    start: 256,
    paper_ids: ["0".repeat(40)],
  }, 0, 257),
  /block/,
  "a block fetched for another ordinal must fail closed"
);

console.log("search v2 core contract passed");
