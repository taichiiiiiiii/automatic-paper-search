import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class Element {
  constructor() { this.listeners = {}; this.children = []; this.open = false; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute(name, value) { this[name] = value; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
}
const ids = ["search-detail-dialog", "search-detail-close", "search-detail-body", "search-detail-open", "search-detail-status"];
const elements = new Map(ids.map(id => [id, new Element()]));
const listeners = {};
const context = {
  URL, setTimeout: () => 1, clearTimeout() {},
  window: {location: {href: "https://example.test/paper/?q=test&page=2"}},
  document: {
    getElementById: id => elements.get(id),
    createElement: () => new Element(),
    addEventListener: (name, fn) => { listeners[name] = fn; },
  },
};
vm.runInNewContext(readFileSync(new URL("../../../docs/assets/search-detail.js", import.meta.url), "utf8"), context);
function click(href, extra = {}) {
  const anchor = new Element(); anchor.href = href; anchor.isConnected = true;
  const event = {button:0, target:{closest:()=>anchor}, preventDefault(){this.prevented = true;}, ...extra};
  listeners.click(event); return {event, anchor};
}
for (const bad of ["https://evil.test/iclr-2026/?paper="+"a".repeat(40), "https://example.test/paper/../private/?paper="+"a".repeat(40)]) {
  assert.equal(click(bad).event.prevented, undefined);
}
const href = "https://example.test/paper/iclr-2026/?paper="+"a".repeat(40);
assert.equal(click(href,{ctrlKey:true}).event.prevented, undefined);
const {event,anchor} = click(href);
assert.equal(event.prevented,true);
assert.equal(elements.get("search-detail-dialog").open,true);
assert.equal(elements.get("search-detail-body").children[0].src,href);
assert.equal(context.window.location.href,"https://example.test/paper/?q=test&page=2");
const frame = elements.get("search-detail-body").children[0];
let keydown;
frame.contentDocument = {addEventListener: (name, fn) => { if(name === "keydown") keydown = fn; }};
frame.listeners.load();
assert.equal(typeof keydown,"function");
frame.contentDocument.querySelector = () => ({});
keydown({key:"Escape",preventDefault(){ throw new Error("nested dialog owns Escape"); }});
assert.equal(elements.get("search-detail-dialog").open,true);
frame.contentDocument.querySelector = () => null;
keydown({key:"Escape",preventDefault(){}});
assert.equal(elements.get("search-detail-body").children.length,0);
assert.equal(anchor.focused,true);
click(href);
const freshMessage = elements.get("search-detail-status").textContent;
frame.listeners.load();
assert.equal(elements.get("search-detail-status").textContent,freshMessage,"stale load cannot change new dialog");
keydown({key:"Escape",preventDefault(){ throw new Error("stale document cannot close new dialog"); }});
assert.equal(elements.get("search-detail-dialog").open,true);
elements.get("search-detail-close").listeners.click();
assert.equal(elements.get("search-detail-dialog").open,false);
console.log("search detail: safe URL, modifier fallback, parent state and focus restoration passed");

const catalogSource = readFileSync(new URL("../../../docs/assets/app.js", import.meta.url), "utf8");
const positioning = catalogSource.slice(catalogSource.indexOf("function placeSelectedPaper("), catalogSource.indexOf("function updateFullAbstractSection("));
for (const height of [0, 100, 240]) {
  const calls = [];
  const card = {style:{setProperty:(name,value)=>calls.push([name,value])},scrollIntoView:()=>calls.push("scroll")};
  vm.runInNewContext(positioning + "\nplaceSelectedPaper();", {
    state:{selectedPaperId:"fixture"}, requestAnimationFrame:fn=>fn(),
    document:{getElementById:id=>id === "paper-fixture" ? card : null,
      querySelector:()=>({getBoundingClientRect:()=>({height})})},
  });
  assert.deepEqual(calls, [["scroll-margin-top",`${height + 16}px`],"scroll"],
    "measure the sticky toolbar before placing the selected card");
}
