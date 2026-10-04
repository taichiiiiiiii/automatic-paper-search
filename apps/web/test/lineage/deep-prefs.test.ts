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
import { resolveView } from "../../lib/lineage/core";
import {
  buildDeepPrefsPayload,
  DEEP_STORAGE_KEY,
  type DeepPrefs,
  type DeepPrefsStore,
  deepDisplayUrl,
  loadDeepRelations,
  parseDeepPrefsJson,
  readDeepPrefs,
  readDeepViewPref,
  readRelationsParam,
  resolveInitialRelations,
  saveDeepPrefs,
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

describe("buildDeepPrefsPayload / saveDeepPrefs (the page's save path)", () => {
  it("serialises the filter with no view when none is given", () => {
    expect(buildDeepPrefsPayload(setOf("extends", "supersedes"))).toEqual({
      visibleRelations: ["extends", "supersedes"],
    });
  });

  it("always writes the CURRENT view together with the filter, like deep.js savePrefs", () => {
    expect(buildDeepPrefsPayload(setOf("extends"), "graph")).toEqual({
      visibleRelations: ["extends"],
      view: "graph",
    });
    expect(buildDeepPrefsPayload(setOf("extends"), "list")).toEqual({
      visibleRelations: ["extends"],
      view: "list",
    });
  });

  it("round-trips through storage: a relations-only save with the page's current view overwrites, not merges", () => {
    // deep.js's savePrefs never re-reads storage first -- a save always
    // reflects the page's own current state, so a stale stored "list"
    // is replaced outright by whatever view the page passes in.
    const store = storeWith({ view: "list", visibleRelations: ["supersedes"] });
    saveDeepPrefs(setOf("extends", "contrasts"), "graph", () => store);
    expect(storedPrefs(store).view).toBe("graph");
    expect(sorted(loadDeepRelations(null, () => store))).toEqual(["contrasts", "extends"]);
  });

  it("still writes when the stored blob is unreadable", () => {
    const store = memoryStore({ [DEEP_STORAGE_KEY]: "{" });
    saveDeepPrefs(setOf("extends"), "graph", () => store);
    expect(storedPrefs(store)).toEqual({ visibleRelations: ["extends"], view: "graph" });
  });

  it("survives a setItem that throws (private mode / quota)", () => {
    const throwingSet: DeepPrefsStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => saveDeepPrefs(setOf("extends"), "graph", () => throwingSet)).not.toThrow();
  });

  it("survives a localStorage getter that throws, writing nothing", () => {
    const blocked = () => {
      throw new Error("SecurityError: localStorage is blocked");
    };
    expect(() => saveDeepPrefs(setOf("extends"), "graph", blocked)).not.toThrow();
  });

  it("ignores a storage source that is simply absent (server)", () => {
    expect(() => saveDeepPrefs(setOf("extends"), "graph", () => null)).not.toThrow();
  });
});

describe("readDeepViewPref + core.ts resolveView (deep.js's initial state.view)", () => {
  it("reads a valid stored view", () => {
    expect(readDeepViewPref({ view: "list" })).toBe("list");
  });

  it("returns null for a missing/non-string stored view, same as a missing prefs blob", () => {
    expect(readDeepViewPref(null)).toBeNull();
    expect(readDeepViewPref({})).toBeNull();
    expect(readDeepViewPref({ view: 42 })).toBeNull();
  });

  it("feeds straight into core.ts resolveView with the same precedence as deep.js's own init", () => {
    expect(resolveView({ urlView: "list", savedView: readDeepViewPref({ view: "graph" }) })).toBe(
      "list",
    );
    expect(resolveView({ urlView: null, savedView: readDeepViewPref({ view: "graph" }) })).toBe(
      "graph",
    );
    expect(resolveView({ urlView: null, savedView: readDeepViewPref(null) })).toBe("graph");
    expect(
      resolveView({
        urlView: null,
        savedView: readDeepViewPref(null),
        matchMedia: () => ({ matches: true }),
      }),
    ).toBe("list");
  });
});

describe("serializeRelationsParam / deepDisplayUrl (deep.js syncDisplayUrl)", () => {
  it("sorts so a bookmarked URL is stable whatever the click order was", () => {
    expect(serializeRelationsParam(setOf("contrasts", "ablation", "extends"))).toBe(
      "ablation,contrasts,extends",
    );
    expect(serializeRelationsParam(new Set<Relation>())).toBe("");
  });

  it("replaces both the view and relations keys, keeping every other parameter", () => {
    const href = deepDisplayUrl(
      "https://example.test/iclr-2026/deep/?paper=abc&view=list&relations=supersedes",
      setOf("extends", "contrasts"),
      "graph",
    );
    const params = new URL(href).searchParams;
    expect(params.get("relations")).toBe("contrasts,extends");
    expect(params.get("paper")).toBe("abc");
    expect(params.get("view")).toBe("graph");
    expect([...params.keys()].filter((key) => key === "relations")).toHaveLength(1);
    expect([...params.keys()].filter((key) => key === "view")).toHaveLength(1);
  });

  it("adds both keys when the URL has no query yet", () => {
    const href = deepDisplayUrl("https://example.test/iclr-2026/deep/", setOf("extends"), "list");
    const params = new URL(href).searchParams;
    expect(params.get("view")).toBe("list");
    expect(params.get("relations")).toBe("extends");
  });
});
