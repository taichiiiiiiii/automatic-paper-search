import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "../../../docs/assets/paper-slides.js");
const source = readFileSync(scriptPath, "utf8");

await import(`${pathToFileURL(scriptPath).href}?contract=1`);
const core = globalThis.PaperPilotSlidesCore;
assert.ok(core, "paper-slides.js exposes its dependency-free navigation core");

const ids = ["s01", "s02", "s03"];
assert.equal(core.slideIndexForHash("#s01", ids), 0);
assert.equal(core.slideIndexForHash("#s03", ids), 2);
assert.equal(core.slideIndexForHash("#s99", ids), null);
assert.equal(core.slideIndexForHash("#citation-c01", ids), null);
assert.equal(core.slideIndexForHash("#s01%0a", ids), null);

assert.equal(core.citationIdForHash("#citation-c01"), "citation-c01");
assert.equal(core.citationIdForHash("#citation-c99"), "citation-c99");
assert.equal(core.citationIdForHash("#citation-c00"), null);
assert.equal(core.citationIdForHash("#citation-c01-extra"), null);

assert.equal(core.targetIndexForKey("ArrowRight", 0, 3), 1);
assert.equal(core.targetIndexForKey("PageDown", 2, 3), 2);
assert.equal(core.targetIndexForKey("ArrowLeft", 0, 3), 0);
assert.equal(core.targetIndexForKey("PageUp", 2, 3), 1);
assert.equal(core.targetIndexForKey("Home", 2, 3), 0);
assert.equal(core.targetIndexForKey("End", 0, 3), 2);
assert.equal(core.targetIndexForKey("Enter", 1, 3), null);
assert.equal(core.targetIndexForKey("ArrowRight", 0, 0), null);

for (const tag of ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]) {
  assert.equal(core.isInteractiveTag(tag), true, `${tag} is interactive`);
}
assert.equal(core.isInteractiveTag("BODY"), false);
assert.equal(core.isInteractiveTag("SECTION"), false);
assert.equal(core.scrollBehaviorForMotion(true), "auto");
assert.equal(core.scrollBehaviorForMotion(false), "smooth");
assert.match(source, /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)/);

for (const forbidden of [
  "innerHTML",
  "insertAdjacentHTML",
  "XMLHttpRequest",
  "localStorage",
  "sessionStorage",
  "serviceWorker",
  "document.cookie",
  "fetch(",
  "eval(",
  "new Function",
  "import(",
]) {
  assert.equal(source.includes(forbidden), false, `forbidden browser API: ${forbidden}`);
}

assert.match(source, /addEventListener\("keydown"/);
assert.match(source, /addEventListener\("hashchange"/);
assert.match(source, /focus\(/);
assert.match(source, /replaceState\(/);
assert.doesNotMatch(source, /https?:\/\//);

console.log("paper slide viewer contract passed");
