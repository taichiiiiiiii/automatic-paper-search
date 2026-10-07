// @vitest-environment jsdom
//
// P2 review LOW -- components/lineage/focus/FocusView.tsx's popstate
// handler set `closedMessage` when a URL could not be projected, but
// never cleared it on a LATER popstate that projects fine again: once
// shown, the "監査済みの系譜は表示できません" screen stayed up forever
// for the rest of this component's lifetime, even after Back/Forward
// reached a URL that resolves cleanly. Uses the same real, verified
// "positive-release" fixture bundle as test/lineage/focus/v2-core.test.ts
// (not a hand-built double) so this exercises the actual
// readState -> selectFocusProjection pipeline, not a mock of it.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FocusView } from "../../../components/lineage/focus/FocusView";
import {
  type FocusViewState,
  parsePilotIndex,
  type Release,
  readState,
  resolvePilotEntry,
  selectFocusProjection,
  verifyPilotRelease,
} from "../../../lib/lineage/v2";
import type { PilotIndex, PilotIndexEntry } from "../../../lib/lineage/v2/types";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../../..");
const bundleRoot = resolve(repository, "apps/web/test/fixtures/lineage-pilot/positive-release");

// `verifyPilotRelease`'s `asBytes` only accepts a same-realm
// `ArrayBuffer`/`Uint8Array` (`instanceof` checks, by design --
// json.ts's own header). Under this file's `jsdom` environment, a
// Node `Buffer` from `readFileSync` fails `instanceof Uint8Array`
// even though `Uint8Array === globalThis.Uint8Array` (a cross-realm
// artifact of how vitest's jsdom environment sets up `Buffer`'s
// prototype chain) -- re-wrapping via `new Uint8Array(...)` produces
// a genuine instance of THIS realm's `Uint8Array`, same as a real
// `fetch(...).arrayBuffer()` would in a browser.
function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

async function loadRelease(): Promise<Release> {
  const raw = JSON.parse(
    readFileSync(resolve(bundleRoot, "lineage-pilot-index-v1.json"), "utf8"),
  ) as { entries: PilotIndexEntry[] };
  const index = parsePilotIndex(raw) as PilotIndex;
  const entry = resolvePilotEntry(
    index,
    (raw.entries[0] as PilotIndexEntry).paper_id,
  ) as PilotIndexEntry;
  const catalog = JSON.parse(readFileSync(resolve(bundleRoot, "catalog.json"), "utf8")) as Array<{
    paper_id: string;
  }>;
  const release = await verifyPilotRelease({
    entry,
    artifactBytes: readBytes(resolve(bundleRoot, entry.artifact.path)),
    fixtureBytes: readBytes(resolve(bundleRoot, entry.fixture.path)),
    qualityBytes: readBytes(resolve(bundleRoot, entry.quality.path)),
    catalogPaperIds: catalog.map((paper) => paper.paper_id),
  });
  if (!release) throw new Error("fixture release failed to verify -- fixture itself is broken");
  return release;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("FocusView popstate recovery from a closed message", () => {
  it("recovers to the real view on a later popstate that projects fine again", async () => {
    const release = await loadRelease();
    const initialState = readState(release, {
      params: new URLSearchParams(""),
      prefs: {},
      mobile: false,
    }) as FocusViewState;
    expect(selectFocusProjection(release, initialState)).not.toBeNull();

    render(<FocusView release={release} initialState={initialState} />);
    expect(screen.queryByText("監査済みの系譜は表示できません")).toBeNull();

    // An unresolvable `?focus=` -- popstate must close the view.
    await act(async () => {
      window.history.pushState(null, "", "/?focus=does-not-exist");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByText("監査済みの系譜は表示できません")).toBeTruthy();
    expect(
      screen.getByText("指定された focus または表示条件を安全に復元できませんでした。"),
    ).toBeTruthy();

    // Back to a URL that resolves fine -- the view must recover, not
    // stay wedged on the closed message.
    await act(async () => {
      window.history.pushState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByText("監査済みの系譜は表示できません")).toBeNull();
  });
});
