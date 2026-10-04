/**
 * Pins lib/lineage/deep-prefs.ts against the `pp.deep.prefs` /
 * `?relations=` block at the top of docs/assets/deep.js (`loadPrefs`,
 * `savePrefs`, the `visibleRelations` field of its `state` literal and
 * `syncDisplayUrl`). There is no JS unit test for that block to port:
 * paperpilot/tests/viewer/test_deep_publication_gate.mjs runs deep.js
 * under node:vm for the *publication* gate only, and
 * test_lineage_viewer_contract.mjs merely greps the source. So these
 * cases are written straight from the original's expressions --
 * including the precedence quirk it has (`urlRelations.length > 0 ?
 * urlRelations : ...` makes an empty or all-unknown `?relations=` fall
 * through to the saved prefs instead of meaning "show nothing").
 *
 * Runs in plain node (no vitest config sets an environment, so there is
 * no jsdom `localStorage`), and storage always arrives through the
 * thunk -- which is exactly how the private-mode requirement gets
 * tested: a stub that throws on access, on `getItem` or on `setItem`
 * must still leave the page holding a usable filter.
 */
import { describe, expect, it } from "vitest";
import type { Relation } from "../../lib/lineage/core";
import {
  buildDeepPrefsPayload,
  DEEP_STORAGE_KEY,
  type DeepPrefs,
  type DeepPrefsStore,
  deepDisplayUrl,
  loadDeepRelations,
  parseDeepPrefsJson,
  readDeepPrefs,
  readRelationsParam,
  resolveInitialRelations,
  saveDeepRelations,
  serializeRelationsParam,
} from "../../lib/lineage/deep-prefs";
import { STORAGE_KEY as LINEAGE_STORAGE_KEY } from "../../lib/lineage/layout/constants";
import { DEFAULT_VISIBLE_RELATIONS } from "../../lib/lineage/relations";

const DEFAULTS = [...DEFAULT_VISIBLE_RELATIONS].sort();

function setOf(...relations: Relation[]): Set<Relation> {
  return new Set(relations);
}

function sorted(relations: ReadonlySet<Relation>): string[] {
  return [...relations].sort();
}

function memoryStore(initial: Record<string, string> = {}): DeepPrefsStore {
  const backing = new Map(Object.entries(initial));
  return {
    getItem: (key: string): string | null => backing.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      backing.set(key, value);
    },
  };
}

/** A store already holding a `pp.deep.prefs` blob, as the current site
 * would have written it. */
function storeWith(blob: unknown): DeepPrefsStore {
  return memoryStore({ [DEEP_STORAGE_KEY]: JSON.stringify(blob) });
}

function storedPrefs(store: DeepPrefsStore): Record<string, unknown> {
  const raw = store.getItem(DEEP_STORAGE_KEY);
  expect(typeof raw).toBe("string");
  return JSON.parse(raw ?? "{}") as Record<string, unknown>;
}

describe("deep prefs storage key", () => {
  it("is deep.js's own key, not the conference lineage viewer's", () => {
    expect(DEEP_STORAGE_KEY).toBe("pp.deep.prefs");
    expect(DEEP_STORAGE_KEY).not.toBe(LINEAGE_STORAGE_KEY);
  });
});

describe("parseDeepPrefsJson", () => {
  it("returns null for nothing stored, empty, malformed or non-object JSON", () => {
    expect(parseDeepPrefsJson(null)).toBeNull();
    expect(parseDeepPrefsJson("")).toBeNull();
    expect(parseDeepPrefsJson("{not json")).toBeNull();
    expect(parseDeepPrefsJson("42")).toBeNull();
    expect(parseDeepPrefsJson("null")).toBeNull();
    expect(parseDeepPrefsJson('"extends"')).toBeNull();
  });

  it("keeps an object blob as-is (untrusted data, validated by consumers)", () => {
    expect(parseDeepPrefsJson('{"visibleRelations":["extends"]}')).toEqual({
      visibleRelations: ["extends"],
    });
  });
});

describe("readRelationsParam", () => {
  it("reads the relations key out of a location.search string", () => {
    expect(readRelationsParam("?paper=abc&relations=extends,contrasts")).toBe("extends,contrasts");
    expect(readRelationsParam("relations=extends")).toBe("extends");
    expect(readRelationsParam("?paper=abc")).toBeNull();
    expect(readRelationsParam(null)).toBeNull();
    expect(readRelationsParam(undefined)).toBeNull();
    expect(readRelationsParam("")).toBeNull();
  });
});

describe("resolveInitialRelations (deep.js's precedence)", () => {
  it("uses deep.js's DEFAULT_RELATIONS when nothing is stored and no URL filter", () => {
    expect(sorted(resolveInitialRelations(null, null))).toEqual(DEFAULTS);
    expect(resolveInitialRelations(null, null).has("baseline_only")).toBe(false);
  });

  it("restores the stored filter", () => {
    const prefs: DeepPrefs = { view: "list", visibleRelations: ["baseline_only", "extends"] };
    expect(sorted(resolveInitialRelations(null, prefs))).toEqual(["baseline_only", "extends"]);
  });

  it("lets the URL override the stored filter", () => {
    const prefs: DeepPrefs = { visibleRelations: ["supersedes"] };
    expect(sorted(resolveInitialRelations("extends,contrasts", prefs))).toEqual([
      "contrasts",
      "extends",
    ]);
  });

  it("drops unknown relations from the URL but keeps the valid ones", () => {
    expect(sorted(resolveInitialRelations("not-a-relation,extends", null))).toEqual(["extends"]);
  });

  it("drops unknown or non-string relations from the stored list", () => {
    const prefs: DeepPrefs = { visibleRelations: ["extends", "not-a-relation", 42, null, {}] };
    expect(sorted(resolveInitialRelations(null, prefs))).toEqual(["extends"]);
  });

  it("treats a non-array, empty or absent stored list as unset", () => {
    expect(sorted(resolveInitialRelations(null, { visibleRelations: "extends" }))).toEqual(
      DEFAULTS,
    );
    expect(sorted(resolveInitialRelations(null, { visibleRelations: [] }))).toEqual(DEFAULTS);
    expect(sorted(resolveInitialRelations(null, {}))).toEqual(DEFAULTS);
  });

  it("keeps the original's fall-through: an empty or all-unknown URL filter restores prefs", () => {
    const prefs: DeepPrefs = { visibleRelations: ["ablation"] };
    expect(sorted(resolveInitialRelations("", prefs))).toEqual(["ablation"]);
    expect(sorted(resolveInitialRelations("not-a-relation,also-unknown", prefs))).toEqual([
      "ablation",
    ]);
    expect(sorted(resolveInitialRelations("", null))).toEqual(DEFAULTS);
  });

  it("collapses duplicates", () => {
    expect(sorted(resolveInitialRelations("extends,extends", null))).toEqual(["extends"]);
  });
});

describe("loadDeepRelations (the page's load path)", () => {
  it("restores a pp.deep.prefs blob written by the current site", () => {
    const store = storeWith({ view: "graph", visibleRelations: ["contrasts"] });
    expect(sorted(loadDeepRelations(null, () => store))).toEqual(["contrasts"]);
  });

  it("reads the URL before storage, same as the original", () => {
    const store = storeWith({ visibleRelations: ["contrasts"] });
    expect(sorted(loadDeepRelations("?relations=extends", () => store))).toEqual(["extends"]);
  });

  it("falls back to the defaults with no store at all (server render)", () => {
    expect(sorted(loadDeepRelations(null, () => null))).toEqual(DEFAULTS);
  });

  it("survives a localStorage getter that throws (Safari private mode)", () => {
    const blocked = () => {
      throw new Error("SecurityError: localStorage is blocked");
    };
    expect(sorted(loadDeepRelations("?relations=extends", blocked))).toEqual(["extends"]);
    expect(sorted(loadDeepRelations(null, blocked))).toEqual(DEFAULTS);
  });

  it("survives a getItem that throws and unreadable stored JSON", () => {
    const throwingGet: DeepPrefsStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    expect(sorted(loadDeepRelations(null, () => throwingGet))).toEqual(DEFAULTS);
    const corrupt = memoryStore({ [DEEP_STORAGE_KEY]: "{" });
    expect(sorted(loadDeepRelations(null, () => corrupt))).toEqual(DEFAULTS);
  });
});

describe("readDeepPrefs", () => {
  it("never throws, whichever part of storage fails", () => {
    expect(readDeepPrefs(() => null)).toBeNull();
    expect(readDeepPrefs(() => memoryStore())).toBeNull();
    expect(readDeepPrefs(() => storeWith({ visibleRelations: ["extends"] }))).toEqual({
      visibleRelations: ["extends"],
    });
  });
});

describe("buildDeepPrefsPayload / saveDeepRelations (the page's save path)", () => {
  it("serialises the filter under deep.js's own field name", () => {
    expect(buildDeepPrefsPayload(setOf("extends", "supersedes"))).toEqual({
      visibleRelations: ["extends", "supersedes"],
    });
  });

  it("keeps a stored view so this page's relations-only write cannot reset it", () => {
    const previous: DeepPrefs = { view: "graph", visibleRelations: ["extends"] };
    expect(buildDeepPrefsPayload(setOf("extends"), previous)).toEqual({
      visibleRelations: ["extends"],
      view: "graph",
    });
  });

  it("drops an unusable stored view instead of carrying it forward", () => {
    expect(buildDeepPrefsPayload(setOf("extends"), { view: "topics" })).toEqual({
      visibleRelations: ["extends"],
    });
  });

  it("round-trips through storage, keeping the unrelated stored field", () => {
    const store = storeWith({ view: "graph", visibleRelations: ["supersedes"] });
    saveDeepRelations(setOf("extends", "contrasts"), () => store);
    expect(storedPrefs(store).view).toBe("graph");
    expect(sorted(loadDeepRelations(null, () => store))).toEqual(["contrasts", "extends"]);
  });

  it("still writes when the stored blob is unreadable", () => {
    const store = memoryStore({ [DEEP_STORAGE_KEY]: "{" });
    saveDeepRelations(setOf("extends"), () => store);
    expect(storedPrefs(store)).toEqual({ visibleRelations: ["extends"] });
  });

  it("survives a setItem that throws (private mode / quota)", () => {
    const throwingSet: DeepPrefsStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => saveDeepRelations(setOf("extends"), () => throwingSet)).not.toThrow();
  });

  it("survives a localStorage getter that throws, writing nothing", () => {
    const blocked = () => {
      throw new Error("SecurityError: localStorage is blocked");
    };
    expect(() => saveDeepRelations(setOf("extends"), blocked)).not.toThrow();
  });

  it("ignores a storage source that is simply absent (server)", () => {
    expect(() => saveDeepRelations(setOf("extends"), () => null)).not.toThrow();
  });
});

describe("serializeRelationsParam / deepDisplayUrl (deep.js syncDisplayUrl)", () => {
  it("sorts so a bookmarked URL is stable whatever the click order was", () => {
    expect(serializeRelationsParam(setOf("contrasts", "ablation", "extends"))).toBe(
      "ablation,contrasts,extends",
    );
    expect(serializeRelationsParam(new Set<Relation>())).toBe("");
  });

  it("replaces the relations key and keeps every other parameter", () => {
    const href = deepDisplayUrl(
      "https://example.test/iclr-2026/deep/?paper=abc&view=graph&relations=supersedes",
      setOf("extends", "contrasts"),
    );
    const params = new URL(href).searchParams;
    expect(params.get("relations")).toBe("contrasts,extends");
    expect(params.get("paper")).toBe("abc");
    expect(params.get("view")).toBe("graph");
    expect([...params.keys()].filter((key) => key === "relations")).toHaveLength(1);
  });

  it("adds the key when the URL has no query yet", () => {
    expect(deepDisplayUrl("https://example.test/iclr-2026/deep/", setOf("extends"))).toBe(
      "https://example.test/iclr-2026/deep/?relations=extends",
    );
  });
});
