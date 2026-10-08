// Unit tests for lib/themes-url-state.ts, the P2 review M8a port of
// docs/assets/theme.js's readUrlState()/syncUrlState()/loadPrefs()/
// savePrefs(). All pure (injectable storage) -- no jsdom needed.
import { describe, expect, it } from "vitest";
import {
  loadThemePrefs,
  readTreeUrlState,
  saveThemePrefs,
  THEME_PREFS_STORAGE_KEY,
  type ThemePrefs,
  writeTreeUrlParams,
} from "../../lib/themes-url-state";

describe("readTreeUrlState", () => {
  it("returns all-null/default fields for an empty query string", () => {
    expect(readTreeUrlState("")).toEqual({
      xAxisMode: null,
      yearMin: null,
      yearMax: null,
      searchQuery: null,
      visibleRelations: null,
      hideOrphans: null,
      node: null,
    });
  });

  it("accepts a known xaxis mode", () => {
    expect(readTreeUrlState("?xaxis=genealogy").xAxisMode).toBe("genealogy");
  });

  it("rejects an unknown xaxis mode (allowlist guard)", () => {
    expect(readTreeUrlState("?xaxis=not-a-mode").xAxisMode).toBeNull();
  });

  it("parses ymin/ymax as integers", () => {
    const s = readTreeUrlState("?ymin=2014&ymax=2026");
    expect(s.yearMin).toBe(2014);
    expect(s.yearMax).toBe(2026);
  });

  it("ignores a non-numeric ymin/ymax", () => {
    const s = readTreeUrlState("?ymin=abc&ymax=");
    expect(s.yearMin).toBeNull();
    expect(s.yearMax).toBeNull();
  });

  it("reads q verbatim (not trimmed/lowercased -- caller's job)", () => {
    expect(readTreeUrlState("?q=Flash+Attention").searchQuery).toBe("Flash Attention");
  });

  it("distinguishes an absent q from an explicit empty q", () => {
    expect(readTreeUrlState("").searchQuery).toBeNull();
    expect(readTreeUrlState("?q=").searchQuery).toBe("");
  });

  it("parses a comma-separated rels list, dropping unknown entries", () => {
    const s = readTreeUrlState("?rels=extends,bogus,successor");
    expect(s.visibleRelations).toEqual(["extends", "successor"]);
  });

  it("falls back to null when every requested relation is unknown", () => {
    expect(readTreeUrlState("?rels=bogus,also-bogus").visibleRelations).toBeNull();
  });

  it("maps orphan=show/hide to false/true", () => {
    expect(readTreeUrlState("?orphan=show").hideOrphans).toBe(false);
    expect(readTreeUrlState("?orphan=hide").hideOrphans).toBe(true);
  });

  it("treats an unrecognised orphan value as absent", () => {
    expect(readTreeUrlState("?orphan=maybe").hideOrphans).toBeNull();
  });

  it("extracts the raw node permalink value", () => {
    expect(readTreeUrlState("?node=abc123").node).toBe("abc123");
  });

  it("treats an empty node param as absent", () => {
    expect(readTreeUrlState("?node=").node).toBeNull();
  });
});

describe("writeTreeUrlParams", () => {
  const dataYearExtents = { min: 2014, max: 2026 };
  const base = {
    xAxisMode: "rank" as const,
    yearRange: dataYearExtents,
    dataYearExtents,
    searchQuery: "",
    visibleRelations: new Set(["supersedes", "successor", "extends", "ablation"] as const),
    hideOrphans: true,
  };

  it("writes nothing for every default value", () => {
    const params = new URLSearchParams("?node=keep-me");
    writeTreeUrlParams(params, base);
    expect(params.toString()).toBe("node=keep-me");
  });

  it("writes xaxis only when it differs from the default", () => {
    const params = new URLSearchParams();
    writeTreeUrlParams(params, { ...base, xAxisMode: "genealogy" });
    expect(params.get("xaxis")).toBe("genealogy");
  });

  it("writes ymin/ymax only when they narrow past the data extents", () => {
    const params = new URLSearchParams();
    writeTreeUrlParams(params, { ...base, yearRange: { min: 2018, max: 2026 } });
    expect(params.get("ymin")).toBe("2018");
    expect(params.get("ymax")).toBeNull();
  });

  it("clears a stale ymin/ymax after the range widens back to the defaults", () => {
    const params = new URLSearchParams("?ymin=2018");
    writeTreeUrlParams(params, { ...base, yearRange: dataYearExtents });
    expect(params.get("ymin")).toBeNull();
  });

  it("writes q only when non-empty", () => {
    const params = new URLSearchParams();
    writeTreeUrlParams(params, { ...base, searchQuery: "flash attention" });
    expect(params.get("q")).toBe("flash attention");
  });

  it("writes rels only when they differ from the default set (order-insensitive)", () => {
    const params = new URLSearchParams();
    writeTreeUrlParams(params, {
      ...base,
      visibleRelations: new Set(["extends", "contrasts"]),
    });
    expect(params.get("rels")).toBe("contrasts,extends");
  });

  it("omits rels when the set matches the defaults regardless of insertion order", () => {
    const params = new URLSearchParams("?rels=stale");
    writeTreeUrlParams(params, {
      ...base,
      visibleRelations: new Set(["ablation", "supersedes", "successor", "extends"]),
    });
    expect(params.get("rels")).toBeNull();
  });

  it("writes orphan=show only when hideOrphans is false", () => {
    const params = new URLSearchParams();
    writeTreeUrlParams(params, { ...base, hideOrphans: false });
    expect(params.get("orphan")).toBe("show");
  });

  it("clears orphan when hideOrphans is true (the default)", () => {
    const params = new URLSearchParams("?orphan=show");
    writeTreeUrlParams(params, { ...base, hideOrphans: true });
    expect(params.get("orphan")).toBeNull();
  });

  it("omits ymin/ymax entirely when the data has no plausible years", () => {
    const params = new URLSearchParams("?ymin=2000&ymax=2001");
    writeTreeUrlParams(params, { ...base, yearRange: null, dataYearExtents: null });
    expect(params.get("ymin")).toBeNull();
    expect(params.get("ymax")).toBeNull();
  });
});

describe("loadThemePrefs / saveThemePrefs", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      _data: data,
    };
  }

  it("returns null when nothing is stored", () => {
    expect(loadThemePrefs(fakeStorage())).toBeNull();
  });

  it("round-trips a valid prefs object through save then load", () => {
    const storage = fakeStorage();
    const prefs: ThemePrefs = { xAxisMode: "venue", visibleRelations: ["extends", "contrasts"] };
    saveThemePrefs(storage, prefs);
    expect(loadThemePrefs(storage)).toEqual(prefs);
  });

  it("degrades to null on corrupted JSON instead of throwing", () => {
    const storage = fakeStorage({ [THEME_PREFS_STORAGE_KEY]: "{not json" });
    expect(() => loadThemePrefs(storage)).not.toThrow();
    expect(loadThemePrefs(storage)).toBeNull();
  });

  it("falls back to the default xAxisMode when the stored value is unknown", () => {
    const storage = fakeStorage({
      [THEME_PREFS_STORAGE_KEY]: JSON.stringify({
        xAxisMode: "bogus",
        visibleRelations: ["extends"],
      }),
    });
    expect(loadThemePrefs(storage)?.xAxisMode).toBe("rank");
  });

  it("drops unknown relations and falls back to the full default set when none remain", () => {
    const storage = fakeStorage({
      [THEME_PREFS_STORAGE_KEY]: JSON.stringify({ xAxisMode: "rank", visibleRelations: ["bogus"] }),
    });
    expect(loadThemePrefs(storage)?.visibleRelations).toEqual([
      "supersedes",
      "successor",
      "extends",
      "ablation",
    ]);
  });

  it("never throws when storage access itself throws (private-mode)", () => {
    const throwing: { getItem: () => string; setItem: () => void } = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => loadThemePrefs(throwing)).not.toThrow();
    expect(loadThemePrefs(throwing)).toBeNull();
    expect(() =>
      saveThemePrefs(throwing, { xAxisMode: "rank", visibleRelations: [] }),
    ).not.toThrow();
  });
});
