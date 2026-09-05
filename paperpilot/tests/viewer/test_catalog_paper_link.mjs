import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreUrl = pathToFileURL(
  resolve(__dirname, "../../../docs/assets/catalog-core.js")
).href;
await import(`${coreUrl}?contract=paper-link-v1`);

const core = globalThis.PaperPilotCatalogCore;
assert.ok(core, "catalog-core.js must expose PaperPilotCatalogCore");

const idA = "0".repeat(40);
const idB = "a".repeat(40);
const idC = "aa" + "0".repeat(38);
const paperA = { paper_id: idA, title: "A", authors: [], tags: [], abstract: "preview" };
const paperB = { paper_id: idB, title: "B", authors: [], tags: [], abstract: "preview" };

const byId = core.validateCatalog([paperA, paperB]);
assert.equal(byId.get(idA), paperA);
assert.throws(() => core.validateCatalog([paperA, paperA]), /duplicate paper_id/);
assert.throws(
  () => core.validateCatalog([{ ...paperA, paper_id: "not-an-id" }]),
  /paper_id/
);

assert.deepEqual(core.readPaperParam(`?q=A&paper=${idA}`), { raw: idA, paperId: idA });
assert.deepEqual(core.readPaperParam("?paper=BAD"), { raw: "BAD", paperId: null });
assert.deepEqual(core.readPaperParam("?q=A"), { raw: null, paperId: null });

assert.deepEqual(core.pinSelected([paperB], paperA), [paperA, paperB]);
assert.deepEqual(core.pinSelected([paperA, paperB], paperA), [paperA, paperB]);
assert.deepEqual(core.pinSelected([paperB, paperA], paperA), [paperA, paperB]);
assert.equal(core.detailShardUrl(idB), "../paper-details-v1/aa.json");

const shard = {
  schema_version: "paper-details-v1",
  prefix: "aa",
  papers: [[idB, "full abstract"]],
};
assert.equal(core.readDetailAbstract(shard, idB), "full abstract");
assert.equal(
  core.readDetailAbstract({ ...shard, papers: [[idB, ""]] }, idB),
  "",
  "an intentionally empty abstract is a valid record"
);
assert.throws(() => core.readDetailAbstract({ ...shard, prefix: "00" }, idB), /prefix/);
assert.throws(() => core.readDetailAbstract({ ...shard, papers: [] }, idB), /not found/);
assert.throws(
  () => core.readDetailAbstract({ ...shard, papers: [[idB, "x"], [idC, "y"]] }, idB),
  /sorted/
);

const withPaper = core.setPaperParam("https://example.test/iclr/?q=abc", idA);
assert.equal(new URL(withPaper).searchParams.get("q"), "abc");
assert.equal(new URL(withPaper).searchParams.get("paper"), idA);
const withoutPaper = core.setPaperParam(withPaper, null);
assert.equal(new URL(withoutPaper).searchParams.get("q"), "abc");
assert.equal(new URL(withoutPaper).searchParams.has("paper"), false);

console.log("catalog paper-link core contract passed");
