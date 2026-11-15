// @vitest-environment jsdom
//
// #521 U8: with the State Space Models family switcher, family 2 (the
// probabilistic state-space sense) showed three ambiguity notes on top of
// each other: the switcher's own legend, the seed-scope note (「Artificial
// Intelligence」の系譜を表示… — about the sense the seeds followed, i.e.
// family 1, so wrong in family 2) and the wide-span note (repeats what the
// switcher already says). A chosen family now shows the seed-scope note
// only when it holds the majority of the seeds, and no wide-span note;
// "すべて" and themes without families are unchanged.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageFamilies } from "../../components/themes/LineageFamilies";
import { LineageTree } from "../../components/themes/LineageTree";
import { detectFamilies, familyNotices } from "../../lib/themes-families";
import type { LineageArtifact } from "../../lib/themes-quality";
import { seedScopeNotice, wideSpanNotice } from "../../lib/themes-tree";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const SSM = join(__dirname, "../../../../data/published/themes/state-space-models/lineage.json");
const hasSsm = existsSync(SSM);
const load = (): LineageArtifact => JSON.parse(readFileSync(SSM, "utf8"));

function renderPage(artifact: LineageArtifact) {
  return render(
    <LineageFamilies artifact={artifact}>
      {(shown, familyKey, notices) => (
        <LineageTree
          key={familyKey}
          artifact={shown}
          slug="state-space-models"
          themeName="State Space Models"
          notices={notices}
        />
      )}
    </LineageFamilies>,
  );
}

/** Every ambiguity note on the page: the switcher legend + the two notes. */
function ambiguityNotes(): string[] {
  const out: string[] = [];
  const legend = document.querySelector("[data-lineage-families] legend");
  if (legend) out.push(legend.textContent ?? "");
  for (const sel of ["[data-seed-scope-notice]", "[data-wide-span-notice]"]) {
    for (const el of document.querySelectorAll(sel)) out.push(el.textContent ?? "");
  }
  return out;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("pp.theme.onboarded", "1");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe.runIf(hasSsm)("State Space Models family notices (#521 U8)", () => {
  it("family 2 shows at most one ambiguity note and no seed-scope note", () => {
    window.history.replaceState(null, "", "/themes/?theme=state-space-models&fam=2");
    renderPage(load());
    const notes = ambiguityNotes();
    expect(notes.length).toBeLessThanOrEqual(1);
    expect(notes.join("\n")).not.toContain("Artificial Intelligence");
    expect(document.querySelector("[data-seed-scope-notice]")).toBeNull();
    expect(document.querySelector("[data-wide-span-notice]")).toBeNull();
  });

  it("family 2 reached by the switch also drops the wrong note", () => {
    window.history.replaceState(null, "", "/themes/?theme=state-space-models");
    renderPage(load());
    const radio = document.querySelector('input[data-family="2"]') as HTMLInputElement;
    fireEvent.click(radio);
    expect(ambiguityNotes().length).toBeLessThanOrEqual(1);
    expect(document.querySelector("[data-seed-scope-notice]")).toBeNull();
  });

  it("family 1 keeps exactly the notes it had (legend + seed scope, same text)", () => {
    window.history.replaceState(null, "", "/themes/?theme=state-space-models&fam=1");
    const a = load();
    renderPage(a);
    const legend = document.querySelector("[data-lineage-families] legend")?.textContent ?? "";
    expect(ambiguityNotes()).toEqual([legend, seedScopeNotice(a.meta)]);
    expect(document.querySelector("[data-wide-span-notice]")).toBeNull();
  });

  it("すべて keeps all three notes as before", () => {
    window.history.replaceState(null, "", "/themes/?theme=state-space-models&fam=0");
    const a = load();
    renderPage(a);
    const legend = document.querySelector("[data-lineage-families] legend")?.textContent ?? "";
    expect(ambiguityNotes()).toEqual([legend, seedScopeNotice(a.meta), wideSpanNotice(a.nodes)]);
  });
});

describe("familyNotices", () => {
  // Two chains a0..a7 and b0..b5 joined only through the seed "s".
  const a = Array.from({ length: 8 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 6 }, (_, i) => `b${i}`);
  const chain = (ids: string[]) =>
    ids.slice(1).map((id, i) => ({ src: ids[i] as string, dst: id }));
  // Seeds other than "s" sit at chain ends, so only "s" splits the graph.
  const seeds = ["s", "a5", "a6", "a7", "b5"];
  const families = detectFamilies(
    ["s", ...a, ...b].map((id) => ({ id, year: 2020 })),
    [...chain(a), ...chain(b), { src: "s", dst: "a0" }, { src: "s", dst: "b0" }],
    seeds,
  );

  it("shows both notes for すべて and for a theme without families", () => {
    expect(familyNotices(null, 1, seeds)).toEqual({ seedScope: true, wideSpan: true });
    expect(families?.length).toBe(2);
    expect(familyNotices(families, 0, seeds)).toEqual({ seedScope: true, wideSpan: true });
  });

  it("keeps the seed-scope note only in the family holding most seeds", () => {
    const home = families?.find((f) => f.nodeIds.has("a7"))?.index ?? -1;
    const other = families?.find((f) => f.nodeIds.has("b5"))?.index ?? -1;
    expect(home).not.toBe(other);
    expect(familyNotices(families, home, seeds)).toEqual({ seedScope: true, wideSpan: false });
    expect(familyNotices(families, other, seeds)).toEqual({ seedScope: false, wideSpan: false });
  });

  it("an exact half of the seeds is not a majority", () => {
    const half = ["a7", "b5"];
    for (const f of families ?? []) {
      expect(familyNotices(families, f.index, half).seedScope).toBe(false);
    }
  });
});
