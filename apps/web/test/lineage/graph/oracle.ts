// Loads the ORIGINAL docs/assets/lineage.js (+ utils.js) under node:vm
// and exposes its internal layout functions, so parity tests can run
// the real JS implementation against the same inputs as the TS port
// in lib/lineage/layout/* -- same technique as
// paperpilot/tests/viewer/test_theme_xaxis_layout.mjs (stub DOM +
// `globalThis.__test = {...}` probe appended to the script source).
//
// Deliberately NOT a pre-generated fixture: reading the JS source at
// test time means drift between docs/assets/lineage.js and the port
// fails this suite immediately, instead of silently going stale.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { layoutFor } from "@paperpilot/core/layout";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..", "..", "..");
// The original viewer JS this oracle evaluates lives in `legacySite/assets`
// (legacy: docs/assets, same directory as `published`'s own assets/; p5:
// legacy/gh-pages-site/assets, once the A9 data move freezes the old site
// there). Never `published` -- these three files are the hand-written
// viewer scripts, not generated data.
const LEGACY_ASSETS_DIR = join(layoutFor(REPO_ROOT).legacySite, "assets");
const UTILS_JS = join(LEGACY_ASSETS_DIR, "utils.js");
const LINEAGE_JS = join(LEGACY_ASSETS_DIR, "lineage.js");
const DEEP_JS = join(LEGACY_ASSETS_DIR, "deep.js");

function makeStubElement(): Record<string, unknown> {
  const el: Record<string, unknown> = {
    value: "",
    hidden: false,
    innerHTML: "",
    textContent: "",
    style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    dataset: {},
    children: [] as unknown[],
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    appendChild(child: unknown) {
      (el.children as unknown[]).push(child);
      return child;
    },
    insertAdjacentHTML() {},
    insertBefore(node: unknown) {
      return node;
    },
    cloneNode() {
      return makeStubElement();
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    remove() {},
    focus() {},
  };
  return el;
}

export interface LineageOracle {
  layoutTree: (nodes: unknown[], edges: unknown[], focusId: string | null) => unknown[];
  layoutTimeline: (nodes: unknown[]) => unknown[];
  NODE_W: number;
  NODE_H: number;
  LEVEL_GAP: number;
  SIBLING_GAP: number;
  PADDING: number;
  MAX_DEPTH: number;
  fanOffsets: (
    edges: unknown[],
    posById: Map<string, unknown>,
    nodeW: number,
  ) => Map<unknown, number>;
  edgeStyle: (mc: string, conf: unknown) => { opacity: string; width: string } | null;
}

/** Evaluates docs/assets/utils.js then docs/assets/lineage.js (with
 * the trailing `init();` call stripped) in a fresh vm context, and
 * returns the internal functions/constants the parity tests need. */
export function loadLineageOracle(): LineageOracle {
  const stubDoc = {
    getElementById: () => makeStubElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeStubElement(),
    createElementNS: () => makeStubElement(),
    addEventListener() {},
    fonts: { ready: Promise.resolve() },
  };
  const localStorageBacking = new Map<string, string>();
  const localStorageStub = {
    getItem: (k: string) =>
      localStorageBacking.has(k) ? (localStorageBacking.get(k) as string) : null,
    setItem: (k: string, v: string) => localStorageBacking.set(k, v),
    removeItem: (k: string) => localStorageBacking.delete(k),
  };
  const ctx: Record<string, unknown> = {
    document: stubDoc,
    localStorage: localStorageStub,
    URLSearchParams,
    console,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Promise,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  };
  ctx.window = {
    PP: undefined,
    PaperPilotLineageCore: {
      resolveView: () => "graph",
      parseQualityManifest: () => null,
      resolveQualityCollection: () => null,
      qualityRowIsEligible: () => false,
      qualityRowIsPublishable: () => false,
      fetchJsonWithSha256: async () => null,
      parseArtifact: () => null,
      selectActiveEdges: (edges: unknown[]) => edges,
      resolveFocus: () => null,
    },
    location: { search: "", pathname: "/iclr-2026/lineage.html" },
    matchMedia: undefined,
    document: stubDoc,
    localStorage: localStorageStub,
    addEventListener() {},
    removeEventListener() {},
  };
  ctx.globalThis = ctx;
  const context = vm.createContext(ctx);

  const utilsSrc = readFileSync(UTILS_JS, "utf8");
  vm.runInContext(utilsSrc, context, { filename: UTILS_JS });

  const lineageSrc = readFileSync(LINEAGE_JS, "utf8").replace(/\binit\(\);\s*$/, "");
  const probe = `
    globalThis.__oracle = {
      layoutTree,
      layoutTimeline,
      NODE_W,
      NODE_H,
      LEVEL_GAP,
      SIBLING_GAP,
      PADDING,
      MAX_DEPTH,
      fanOffsets: window.PP.fanOffsets,
      edgeStyle: window.PP.edgeStyle,
    };
  `;
  vm.runInContext(`${lineageSrc}\n${probe}`, context, { filename: LINEAGE_JS });

  return ctx.__oracle as LineageOracle;
}

export interface DeepLineageOracle {
  layoutTree: (nodes: unknown[], edges: unknown[], focusId: string | null) => unknown[];
  NODE_W: number;
  NODE_H: number;
  LEVEL_GAP: number;
  SIBLING_GAP: number;
  PADDING: number;
}

/** Same technique as `loadLineageOracle`, but evaluates
 * docs/assets/deep.js instead of docs/assets/lineage.js. deep.js's
 * module-level `init()` call fires fetches and reads `location.search`
 * at eval time, so (like lineage.js's trailing `init();`) it is
 * stripped before the source is run -- the parity tests only need
 * `layoutTree` and the layout constants, not the full init flow (that
 * is covered by paperpilot/tests/viewer/test_deep_publication_gate.mjs
 * separately). */
export function loadDeepOracle(): DeepLineageOracle {
  const stubDoc = {
    getElementById: () => makeStubElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeStubElement(),
    createElementNS: () => makeStubElement(),
    addEventListener() {},
    fonts: { ready: Promise.resolve() },
  };
  const localStorageBacking = new Map<string, string>();
  const localStorageStub = {
    getItem: (k: string) =>
      localStorageBacking.has(k) ? (localStorageBacking.get(k) as string) : null,
    setItem: (k: string, v: string) => localStorageBacking.set(k, v),
    removeItem: (k: string) => localStorageBacking.delete(k),
  };
  const ctx: Record<string, unknown> = {
    document: stubDoc,
    localStorage: localStorageStub,
    URLSearchParams,
    console,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Promise,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  };
  ctx.window = {
    PP: undefined,
    PaperPilotLineageCore: {
      resolveView: () => "graph",
      parseQualityManifest: () => null,
      resolveQualityCollection: () => null,
      qualityRowIsEligible: () => false,
      qualityRowIsPublishable: () => false,
      fetchJsonWithSha256: async () => null,
      parseArtifact: () => null,
      selectActiveEdges: (edges: unknown[]) => edges,
      resolveFocus: () => null,
      resolveManifestEntry: () => null,
      parseDeepManifest: () => null,
    },
    location: { search: "", pathname: "/iclr-2026/deep.html" },
    matchMedia: undefined,
    document: stubDoc,
    localStorage: localStorageStub,
    addEventListener() {},
    removeEventListener() {},
  };
  ctx.globalThis = ctx;
  const context = vm.createContext(ctx);

  const utilsSrc = readFileSync(UTILS_JS, "utf8");
  vm.runInContext(utilsSrc, context, { filename: UTILS_JS });

  const deepSrc = readFileSync(DEEP_JS, "utf8").replace(/\binit\(\);\s*$/, "");
  const probe = `
    globalThis.__oracle = {
      layoutTree,
      NODE_W,
      NODE_H,
      LEVEL_GAP,
      SIBLING_GAP,
      PADDING,
    };
  `;
  vm.runInContext(`${deepSrc}\n${probe}`, context, { filename: DEEP_JS });

  return ctx.__oracle as DeepLineageOracle;
}
