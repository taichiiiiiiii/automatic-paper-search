/**
 * R3-1 / design 52 P0: an OpenReview 403 (`ChallengeRequiredError`, the
 * response every scripted `/notes` call has received since 2026-10) is an
 * explicit `source_blocked` outcome — never an empty or shrunken catalog.
 * The 403 body is the recorded live response (2026-10-11).
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fetchNotes, type OpenReviewNote } from "../../../src/conference/openreview/fetchNotes.js";
import { EXIT_SOURCE_BLOCKED, runOpenreviewMain } from "../../../src/conference/openreview/main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHALLENGE_BODY = JSON.parse(
  readFileSync(join(HERE, "../fixtures/proceedings/openreview_notes_403_challenge.json"), "utf-8"),
) as unknown;

const blocked = () => ({ status: 403, json: async () => CHALLENGE_BODY });

function note(i: number): OpenReviewNote {
  return {
    id: `id${i}`,
    content: {
      title: { value: `paper ${i}` },
      authors: { value: ["A"] },
      venue: { value: "ICML 2026 Poster" },
      venueid: { value: "ICML.cc/2026/Conference" },
    },
  };
}

describe("fetchNotes: 403 ChallengeRequiredError", () => {
  it("reports source_blocked with the OpenReview error name and no notes", async () => {
    const fetchImpl = vi.fn(async () => blocked());
    const r = await fetchNotes("ICML.cc/2026/Conference", { fetchImpl });
    expect(r.outcome).toBe("source_blocked");
    expect(r.complete).toBe(false);
    expect(r.notes).toEqual([]);
    expect(r.blocked).toEqual({ status: 403, errorName: "ChallengeRequiredError" });
    // A 403 is not retried: one request, no hammering a challenge wall.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("drops earlier pages when a later page is blocked (never a shrunken list)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1
        ? { status: 200, json: async () => ({ notes: [note(1), note(2)] }) }
        : blocked();
    });
    const r = await fetchNotes("ICML.cc/2026/Conference", { fetchImpl }, { pageSize: 2 });
    expect(r.outcome).toBe("source_blocked");
    expect(r.notes).toEqual([]);
  });

  it("an unnamed 403 (non-JSON challenge page) is still source_blocked", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 403,
      json: async () => {
        throw new Error("html");
      },
    }));
    const r = await fetchNotes("ICML.cc/2026/Conference", { fetchImpl });
    expect(r.outcome).toBe("source_blocked");
    expect(r.blocked).toEqual({ status: 403, errorName: null });
  });

  it("a normal complete fetch reports outcome=complete", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      json: async () => ({ notes: [note(1)] }),
    }));
    const r = await fetchNotes("ICML.cc/2026/Conference", { fetchImpl });
    expect(r.outcome).toBe("complete");
    expect(r.blocked).toBeNull();
  });
});

describe("runOpenreviewMain: source_blocked", () => {
  it("exits with EXIT_SOURCE_BLOCKED, names the error and writes nothing", async () => {
    const out = mkdtempSync(join(tmpdir(), "or-blocked-"));
    const lines: string[] = [];
    const rc = await runOpenreviewMain(
      ["--conference", "icml-2026", "--venue", "ICML", "--venueid", "ICML.cc/2026/Conference"],
      {
        outputRoot: out,
        request: { fetchImpl: async () => blocked() },
        print: (l) => lines.push(l),
      },
    );
    expect(rc).toBe(EXIT_SOURCE_BLOCKED);
    expect(rc).not.toBe(1);
    expect(lines.join("\n")).toMatch(/source_blocked.*403 ChallengeRequiredError/);
    expect(existsSync(join(out, "icml-2026"))).toBe(false);
  });
});
