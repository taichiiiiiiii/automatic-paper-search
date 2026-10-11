/**
 * R3-1: new-edition watcher over OpenReview `/groups` (recorded responses
 * from 2026-10-11, trimmed to the fields read). Produces pending-edition
 * records (`announced`, `pending_approval`, `auto_publish: false`); never
 * publishes; never drops records on a failed or blocked check.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detectPendingEditions,
  EditionsConfigSchema,
  emptyPendingEditions,
  fetchGroupInfo,
  fetchVenueIds,
  type GroupsFetch,
  PendingEditionsFileSchema,
  parseOpenReviewDate,
  recordFailedCheck,
} from "../../../src/conference/watch/groups.js";
import { EXIT_SOURCE_BLOCKED, runGroupsCli } from "../../../src/conference/watch/groupsCli.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../../..");
const fx = (n: string) =>
  JSON.parse(readFileSync(join(HERE, "../fixtures/proceedings", n), "utf-8")) as unknown;
const VENUES = fx("openreview_groups_venues_excerpt.json");
const ICML = fx("openreview_group_icml_2026_excerpt.json");
const NEURIPS = fx("openreview_group_neurips_2026_excerpt.json");
const CHALLENGE = fx("openreview_notes_403_challenge.json");
const CONFIG = EditionsConfigSchema.parse(
  JSON.parse(readFileSync(join(REPO, "data/config/conference-editions-v1.json"), "utf-8")),
);

const recorded: GroupsFetch = async (url) => {
  const id = new URL(url).searchParams.get("id");
  const body =
    id === "venues"
      ? VENUES
      : id === "ICML.cc/2026/Conference"
        ? ICML
        : id === "NeurIPS.cc/2026/Conference"
          ? NEURIPS
          : { groups: [{ id, content: {} }] };
  return { status: 200, json: async () => body };
};

const NOW = new Date("2026-10-11T00:00:00Z");
const PUBLISHED = new Set([
  "aaai-2026",
  "acl-2025",
  "cvpr-2025",
  "cvpr-2026",
  "eccv-2024",
  "emnlp-2025",
  "iccv-2025",
  "iclr-2026",
  "icml-2025",
  "neurips-2025",
]);

describe("repo config", () => {
  it("data/config/conference-editions-v1.json is valid and never auto-publishes", () => {
    expect(CONFIG.auto_publish).toBe(false);
    expect(CONFIG.venues.find((v) => v.venue_key === "icml")?.proceedings_adapter).toBe("pmlr");
  });
});

describe("fetch helpers", () => {
  it("lists venue ids and reads a group's start date / location", async () => {
    const venues = await fetchVenueIds(recorded);
    expect(venues.status).toBe("ok");
    const info = await fetchGroupInfo("ICML.cc/2026/Conference", recorded);
    expect(info).toEqual({
      status: "ok",
      value: { startDate: "2026-07-06", location: "Seoul, South Korea" },
    });
  });

  it("a 403 on /groups is source_blocked with the error name", async () => {
    const r = await fetchVenueIds(async () => ({ status: 403, json: async () => CHALLENGE }));
    expect(r).toEqual({
      status: "source_blocked",
      httpStatus: 403,
      errorName: "ChallengeRequiredError",
    });
  });

  it("an empty members list is an error, not 'no venues'", async () => {
    const r = await fetchVenueIds(async () => ({
      status: 200,
      json: async () => ({ groups: [{ members: [] }] }),
    }));
    expect(r.status).toBe("error");
  });

  it("parses OpenReview dates strictly", () => {
    expect(parseOpenReviewDate("Dec 06 2026")).toBe("2026-12-06");
    expect(parseOpenReviewDate("2026-12-06")).toBeNull();
    expect(parseOpenReviewDate(undefined)).toBeNull();
  });
});

describe("detectPendingEditions", () => {
  const venueIds = (VENUES as { groups: { members: string[] }[] }).groups[0]?.members ?? [];

  it("announces every watched, unpublished edition and nothing already published", () => {
    const { state, newlyAnnounced, resolved } = detectPendingEditions({
      config: CONFIG,
      venueIds,
      publishedSlugs: PUBLISHED,
      previous: emptyPendingEditions(),
      now: NOW,
      groupInfo: new Map([
        ["ICML.cc/2026/Conference", { startDate: "2026-07-06", location: "Seoul" }],
      ]),
    });
    expect(newlyAnnounced).toEqual([
      "acl-2026",
      "colm-2025",
      "colm-2026",
      "cvpr-2027",
      "eccv-2026",
      "emnlp-2026",
      "iclr-2025",
      "iclr-2027",
      "icml-2026",
      "neurips-2026",
    ]);
    expect(resolved).toEqual([]);
    for (const e of state.editions) {
      expect(e).toMatchObject({
        phase: "announced",
        status: "pending_approval",
        auto_publish: false,
        listed: true,
      });
      expect(PUBLISHED.has(e.edition_id)).toBe(false);
    }
    const icml = state.editions.find((e) => e.edition_id === "icml-2026");
    expect(icml).toMatchObject({
      start_date: "2026-07-06",
      proceedings_adapter: "pmlr",
      display_name: "ICML 2026",
    });
    expect(PendingEditionsFileSchema.parse(state)).toEqual(state);
  });

  it("keeps first_seen_at, marks vanished groups unlisted, resolves published ones", () => {
    const first = detectPendingEditions({
      config: CONFIG,
      venueIds,
      publishedSlugs: PUBLISHED,
      previous: emptyPendingEditions(),
      now: NOW,
    }).state;
    const later = new Date("2026-10-12T00:00:00Z");
    const { state, newlyAnnounced, resolved } = detectPendingEditions({
      config: CONFIG,
      venueIds: venueIds.filter((v) => v !== "EMNLP/2026/Conference"),
      publishedSlugs: new Set([...PUBLISHED, "icml-2026"]),
      previous: first,
      now: later,
    });
    expect(newlyAnnounced).toEqual([]);
    expect(resolved).toEqual(["icml-2026"]);
    const emnlp = state.editions.find((e) => e.edition_id === "emnlp-2026");
    expect(emnlp?.listed).toBe(false);
    expect(emnlp?.first_seen_at).toBe(NOW.toISOString());
    const acl = state.editions.find((e) => e.edition_id === "acl-2026");
    expect(acl?.first_seen_at).toBe(NOW.toISOString());
    expect(acl?.last_seen_at).toBe(later.toISOString());
  });

  it("a failed check leaves every record untouched", () => {
    const first = detectPendingEditions({
      config: CONFIG,
      venueIds,
      publishedSlugs: PUBLISHED,
      previous: emptyPendingEditions(),
      now: NOW,
    }).state;
    const after = recordFailedCheck(
      first,
      { status: "source_blocked", httpStatus: 403, errorName: "ChallengeRequiredError" },
      NOW,
    );
    expect(after.editions).toEqual(first.editions);
    expect(after.last_check).toMatchObject({ status: "source_blocked" });
  });
});

describe("runGroupsCli", () => {
  function fixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "groups-cli-"));
    writeFileSync(join(root, "config.json"), JSON.stringify(CONFIG));
    writeFileSync(
      join(root, "conferences.json"),
      JSON.stringify([...PUBLISHED].map((name) => ({ name }))),
    );
    return root;
  }
  const argv = [
    "--config",
    "config.json",
    "--published",
    "conferences.json",
    "--state",
    "state/pending.json",
  ];

  it("dry-run by default; --write persists; fetches group details only for new editions", async () => {
    const root = fixtureRoot();
    const ids: string[] = [];
    const fetchJson: GroupsFetch = async (url) => {
      ids.push(new URL(url).searchParams.get("id") ?? "");
      return recorded(url);
    };
    const deps = {
      fetchJson,
      now: () => NOW,
      sleep: async () => {},
      print: () => {},
      repoRoot: root,
    };
    expect(await runGroupsCli(argv, deps)).toBe(0);
    expect(() => readFileSync(join(root, "state/pending.json"))).toThrow();
    expect(ids[0]).toBe("venues");
    expect(ids.length).toBeLessThanOrEqual(11);

    ids.length = 0;
    expect(await runGroupsCli([...argv, "--write"], deps)).toBe(0);
    const state = PendingEditionsFileSchema.parse(
      JSON.parse(readFileSync(join(root, "state/pending.json"), "utf-8")),
    );
    expect(state.editions.map((e) => e.edition_id)).toContain("icml-2026");

    ids.length = 0;
    expect(await runGroupsCli([...argv, "--write"], deps)).toBe(0);
    expect(ids).toEqual(["venues"]);
  });

  it("exits 3 on a blocked /groups and keeps the stored editions", async () => {
    const root = fixtureRoot();
    const base = { now: () => NOW, sleep: async () => {}, print: () => {}, repoRoot: root };
    await runGroupsCli([...argv, "--write"], { ...base, fetchJson: recorded });
    const before = JSON.parse(readFileSync(join(root, "state/pending.json"), "utf-8"));
    const rc = await runGroupsCli([...argv, "--write"], {
      ...base,
      fetchJson: async () => ({ status: 403, json: async () => CHALLENGE }),
    });
    expect(rc).toBe(EXIT_SOURCE_BLOCKED);
    const after = JSON.parse(readFileSync(join(root, "state/pending.json"), "utf-8"));
    expect(after.editions).toEqual(before.editions);
    expect(after.last_check.status).toBe("source_blocked");
  });
});
