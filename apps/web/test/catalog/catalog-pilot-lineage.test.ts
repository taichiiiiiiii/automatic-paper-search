/**
 * Ported from paperpilot/tests/viewer/test_catalog_pilot_lineage.mjs
 * (the resolution + deadline-owner cases; the DOM/state-map wiring is
 * now components/catalog/catalog-app.tsx's job, verified by hand -- see
 * the P2 report).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createPilotLineageLookupOwner,
  parsePilotLineageIndex,
  resolvePilotLineageForSelection,
} from "../../lib/catalog-pilot-lineage";

const paperId = "1".repeat(40);
const otherPaperId = "2".repeat(40);

describe("parsePilotLineageIndex", () => {
  it("parses a well-formed index", () => {
    const raw = {
      schema_version: "lineage-pilot-index-v1",
      entries: [{ paper_id: paperId, conference: "synthetic-pilot" }],
    };
    expect(parsePilotLineageIndex(raw)).toEqual(raw);
  });

  it("fails closed on the wrong schema_version", () => {
    expect(parsePilotLineageIndex({ schema_version: "v0", entries: [] })).toBeNull();
  });

  it("fails closed on a malformed entry (bad paper_id / conference slug)", () => {
    expect(
      parsePilotLineageIndex({
        schema_version: "lineage-pilot-index-v1",
        entries: [{ paper_id: "not-an-id", conference: "synthetic-pilot" }],
      }),
    ).toBeNull();
    expect(
      parsePilotLineageIndex({
        schema_version: "lineage-pilot-index-v1",
        entries: [{ paper_id: paperId, conference: "Not A Slug" }],
      }),
    ).toBeNull();
  });

  it("fails closed on a duplicate paper_id", () => {
    expect(
      parsePilotLineageIndex({
        schema_version: "lineage-pilot-index-v1",
        entries: [
          { paper_id: paperId, conference: "a" },
          { paper_id: paperId, conference: "b" },
        ],
      }),
    ).toBeNull();
  });
});

describe("resolvePilotLineageForSelection", () => {
  const index = parsePilotLineageIndex({
    schema_version: "lineage-pilot-index-v1",
    entries: [{ paper_id: paperId, conference: "synthetic-pilot" }],
  });

  it("resolves an entry matching both paper_id and conference", () => {
    expect(resolvePilotLineageForSelection(index, paperId, "synthetic-pilot")).toEqual({
      paper_id: paperId,
      conference: "synthetic-pilot",
    });
  });

  it("returns null for the wrong conference (no cross-conference join on paper_id alone)", () => {
    expect(resolvePilotLineageForSelection(index, paperId, "wrong-conference")).toBeNull();
  });

  it("returns null for a paper_id not in the index", () => {
    expect(resolvePilotLineageForSelection(index, otherPaperId, "synthetic-pilot")).toBeNull();
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
