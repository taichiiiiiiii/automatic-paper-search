/**
 * Ported from paperpilot/tests/viewer/test_catalog_pilot_lineage.mjs
 * (the resolution + deadline-owner cases; the DOM/state-map wiring is
 * components/catalog/catalog-app.tsx's job, verified by hand -- see the
 * P2 report) -- now exercising the FULL lineage-pilot-index-v1 contract
 * (SCR-47/48) that lib/catalog-pilot-lineage.ts delegates to
 * lib/lineage/v2 for, instead of the old hand-rolled subset. Uses the
 * same real fixture as test/lineage/focus/v2-core.test.ts
 * (apps/web/test/fixtures/lineage-pilot/positive-release, copied byte-identically
 * from the deleted paperpilot/tests/fixtures/lineage-pilot/positive-release) so a
 * drift between the fixture and the v2 reader fails here too.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createPilotLineageLookupOwner,
  parsePilotLineageIndex,
  resolvePilotLineageForSelection,
} from "../../lib/catalog-pilot-lineage";
import type { PilotIndexEntry } from "../../lib/lineage/v2";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../..");
const fixturePath = resolve(
  repository,
  "apps/web/test/fixtures/lineage-pilot/positive-release/lineage-pilot-index-v1.json",
);

const rawFixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  schema_version: string;
  entries: PilotIndexEntry[];
};
const fixtureEntry = rawFixture.entries[0] as PilotIndexEntry;
const paperId = fixtureEntry.paper_id;
const conference = fixtureEntry.conference;
const otherPaperId = "2".repeat(40);

function cloneFixture(): typeof rawFixture {
  return structuredClone(rawFixture);
}

describe("parsePilotLineageIndex (full lineage-pilot-index-v1 contract, SCR-47/48)", () => {
  it("parses the real positive-release fixture", () => {
    const parsed = parsePilotLineageIndex(cloneFixture());
    expect(parsed).not.toBeNull();
    expect(parsed?.entries).toHaveLength(1);
    expect(parsed?.entries[0]?.paper_id).toBe(paperId);
    expect(parsed?.entries[0]?.conference).toBe(conference);
  });

  it("accepts today's published empty index", () => {
    expect(
      parsePilotLineageIndex({ schema_version: "lineage-pilot-index-v1", entries: [] }),
    ).toEqual({ schema_version: "lineage-pilot-index-v1", entries: [] });
  });

  it("fails closed on the wrong schema_version", () => {
    expect(parsePilotLineageIndex({ schema_version: "v0", entries: [] })).toBeNull();
  });

  it("fails closed on an entry missing the artifact/fixture/quality triples (the old loose subset shape)", () => {
    expect(
      parsePilotLineageIndex({
        schema_version: "lineage-pilot-index-v1",
        entries: [{ paper_id: paperId, conference }],
      }),
    ).toBeNull();
  });

  it("fails closed on a malformed entry (bad paper_id / conference slug)", () => {
    const badPaperId = cloneFixture();
    (badPaperId.entries[0] as PilotIndexEntry).paper_id = "not-an-id";
    expect(parsePilotLineageIndex(badPaperId)).toBeNull();

    const badConference = cloneFixture();
    (badConference.entries[0] as PilotIndexEntry).conference = "Not A Slug";
    expect(parsePilotLineageIndex(badConference)).toBeNull();
  });

  it("fails closed on a duplicate paper_id", () => {
    const duped = cloneFixture();
    duped.entries.push(structuredClone(fixtureEntry));
    expect(parsePilotLineageIndex(duped)).toBeNull();
  });

  it("fails closed on a wrong collection_id (SCR-47: path cannot be forged via public properties)", () => {
    const tampered = cloneFixture();
    (tampered.entries[0] as PilotIndexEntry).collection_id = "deep:other-conf:paper:xxxx";
    expect(parsePilotLineageIndex(tampered)).toBeNull();
  });

  it("fails closed on a percent-escaped traversal path (SCR-47)", () => {
    const tampered = cloneFixture();
    (tampered.entries[0] as PilotIndexEntry).artifact.path = (
      tampered.entries[0] as PilotIndexEntry
    ).artifact.path.replace("lineage-pilots/", "lineage-pilots/%2e%2e/");
    expect(parsePilotLineageIndex(tampered)).toBeNull();
  });

  it("fails closed on an extra top-level key", () => {
    const tampered = { ...cloneFixture(), extra: true };
    expect(parsePilotLineageIndex(tampered)).toBeNull();
  });
});

describe("resolvePilotLineageForSelection", () => {
  const index = parsePilotLineageIndex(cloneFixture());

  it("resolves an entry matching both paper_id and conference", () => {
    const resolved = resolvePilotLineageForSelection(index, paperId, conference);
    expect(resolved?.paper_id).toBe(paperId);
    expect(resolved?.conference).toBe(conference);
  });

  it("returns null for the wrong conference (no cross-conference join on paper_id alone)", () => {
    expect(resolvePilotLineageForSelection(index, paperId, "wrong-conference")).toBeNull();
  });

  it("returns null for a paper_id not in the index", () => {
    expect(resolvePilotLineageForSelection(index, otherPaperId, conference)).toBeNull();
  });

  it("returns null for a malformed paper_id, even if it happens to match an entry's text", () => {
    expect(resolvePilotLineageForSelection(index, "not-a-paper-id", conference)).toBeNull();
  });

  it("SCR-48: never resolves against a structurally identical index this module did not parse", () => {
    // A hand-built / round-tripped object with the exact same entries as
    // `index`, but never passed through `parsePilotLineageIndex` -- the
    // branded-value replay guard in resolvePilotEntry must reject it
    // rather than resolving on structural equality.
    const unbranded = structuredClone(index);
    expect(resolvePilotLineageForSelection(unbranded, paperId, conference)).toBeNull();
  });
});

describe("createPilotLineageLookupOwner", () => {
  it("fires onTimeout and aborts exactly once when the deadline elapses", () => {
    const captured: { timeoutCallback: (() => void) | null } = { timeoutCallback: null };
    let cleared = false;
    const onTimeout = vi.fn();
    const owner = createPilotLineageLookupOwner(
      paperId,
      {
        setTimer: (cb) => {
          captured.timeoutCallback = cb;
          return 1;
        },
        clearTimer: () => {
          cleared = true;
        },
      },
      onTimeout,
    );
    expect(owner.isActive()).toBe(true);
    captured.timeoutCallback?.();
    expect(owner.isActive()).toBe(false);
    expect(owner.controller.signal.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(cleared).toBe(false); // the deadline that fired clears nothing itself

    // A second manual abandon() after the deadline already fired is a no-op.
    owner.abandon();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("abandon() aborts, deactivates, and clears the pending timer", () => {
    let cleared = false;
    const owner = createPilotLineageLookupOwner(paperId, {
      setTimer: () => 7,
      clearTimer: () => {
        cleared = true;
      },
    });
    owner.abandon();
    expect(owner.controller.signal.aborted).toBe(true);
    expect(owner.isActive()).toBe(false);
    expect(cleared).toBe(true);
  });

  it("finish() deactivates and clears the timer without aborting", () => {
    let cleared = false;
    const owner = createPilotLineageLookupOwner(paperId, {
      setTimer: () => 9,
      clearTimer: () => {
        cleared = true;
      },
    });
    owner.finish();
    expect(owner.controller.signal.aborted).toBe(false);
    expect(owner.isActive()).toBe(false);
    expect(cleared).toBe(true);
  });
});
