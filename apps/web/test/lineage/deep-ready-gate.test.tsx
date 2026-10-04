// @vitest-environment jsdom
//
// app/[conf]/deep/page.tsx coverage for P2 review round 2 findings:
//
//   MEDIUM-3 -- the ready hero copy ("…（監査済み）" / "…検証済みです")
//   used to depend only on `state.phase`/`focusRequestFailed`, so it
//   stayed up even while the SELECTED paper's own artifact fetch
//   errored (or was still loading, or hash/root-mismatched). Fixed by
//   `heroReady = uiReady && artifact !== null && artifactIssue === null`.
//
//   LOW-4 -- `eligibleEntries` used to be built by mapping each
//   ELIGIBLE QUALITY ROW to a manifest entry by `paper_id`
//   (`resolveManifestEntry(manifest, { paper: row.paper_id })`), which
//   can resolve two distinct rows that happen to declare the same
//   `paper_id` to the SAME manifest entry -- listing it twice. Fixed by
//   iterating the MANIFEST's own entries and resolving each one's row
//   by its exact path (`resolveQualityCollection`), ported from
//   deep.js's own manifest-entry-driven binding.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConferenceDeepPage from "../../app/[conf]/deep/page";
import * as dataLineage from "../../lib/data-lineage";
import {
  ARTIFACT_VERSION,
  MANIFEST_VERSION,
  QUALITY_VERSION,
  type QualityManifest,
  type QualityRow,
} from "../../lib/lineage/core";

vi.mock("next/navigation", () => ({
  useParams: () => ({ conf: "test-2026" }),
}));

const MANIFEST_SHA = "c".repeat(64);
const CONF = "test-2026";

function baseAudit() {
  return {
    fixture_sha256: "9".repeat(64),
    evaluated_at: "2026-08-30T00:00:00Z",
    actor: "ci:audit-v1" as const,
    checks: [
      {
        name: "artifact_contract_v1",
        status: "passed" as const,
        observed: 0,
        expected: 0,
        evidence: [],
      },
      {
        name: "golden_fixture",
        status: "passed" as const,
        observed: "fixture-sha",
        expected: "matching frozen fixture",
        evidence: [],
      },
    ],
  };
}

function deepRow(overrides: Partial<QualityRow> = {}): QualityRow {
  return {
    collection_id: `deep:${CONF}:row`,
    kind: "deep",
    slug: CONF,
    label: "Deep",
    path: `${CONF}/deep-2602.18473.json`,
    availability: "ready",
    audit_status: "passed",
    freshness: "fresh",
    generated_at: "2026-08-30T00:00:00Z",
    snapshot_date: null,
    node_count: 1,
    edge_count: 0,
    artifact_schema_version: ARTIFACT_VERSION,
    input_sha256: "d".repeat(64),
    audit: baseAudit(),
    conference: CONF,
    paper_id: "1".repeat(40),
    arxiv_id: "2602.18473",
    manifest_path: `${CONF}/deep-manifest.json`,
    manifest_input_sha256: MANIFEST_SHA,
    ...overrides,
  };
}

function qualityManifest(collections: QualityRow[]): QualityManifest {
  return {
    schema_version: QUALITY_VERSION,
    as_of: "2026-08-30T00:00:00Z",
    audit_version: "audit-v1",
    collections,
  };
}

function manifestEntry(
  paperId: string,
  arxivId: string,
  title: string,
): {
  paper_id: string;
  aliases: [string, string][];
  arxiv_id: string;
  title: string;
  filename: string;
} {
  return {
    paper_id: paperId,
    aliases: [
      ["arxiv", arxivId],
      ["semantic_scholar", `s2-${paperId}`],
    ],
    arxiv_id: arxivId,
    title,
    filename: `deep-${arxivId}.json`,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/test-2026/deep/");
});

describe("conference deep page: hero gate (P2 review MEDIUM-3)", () => {
  it('does not show the "(監査済み)" hero or "検証済みです" note while the selected artifact fetch fails', async () => {
    const row = deepRow();
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: qualityManifest([row]),
    });
    vi.spyOn(dataLineage, "fetchDeepManifestBytes").mockResolvedValue({
      status: "ok",
      data: {
        raw: {
          schema_version: MANIFEST_VERSION,
          conference: CONF,
          generated_at: "2026-08-30T00:00:00Z",
          entries: [manifestEntry(row.paper_id as string, row.arxiv_id as string, "Paper One")],
        },
        sha256: MANIFEST_SHA,
      },
    });
    vi.spyOn(dataLineage, "fetchLineageArtifactBytes").mockResolvedValue({
      status: "error",
      error: "network boom",
    });

    await act(async () => {
      render(<ConferenceDeepPage />);
    });
    await screen.findByRole("alert");

    expect(screen.getByRole("alert").textContent).toContain(
      "この論文の深掘り系譜を検証できませんでした。",
    );
    expect(screen.queryByText(/監査済み/)).toBeNull();
    expect(screen.queryByText(/検証済みです/)).toBeNull();
    // The picker/filter shell itself must still be up (artifact issues
    // are a hero-copy-only distinction, not a full fall-back to the
    // audit-pending shell).
    expect(screen.getByRole("combobox", { name: /Select focus paper/i })).not.toBeNull();
  });
});

describe("conference deep page: manifest-entry-driven picker (P2 review LOW-4)", () => {
  it("does not list the same manifest entry twice when two quality rows declare the same paper_id", async () => {
    // row1's declared paper_id/path pair is internally consistent;
    // row2's `path` matches entry2 but its `paper_id` is (wrongly) the
    // SAME as row1's -- a data inconsistency the old paper_id-driven
    // resolution would have silently papered over by resolving BOTH
    // rows to entry1.
    const paperOne = "1".repeat(40);
    const paperTwo = "2".repeat(40);
    const row1 = deepRow({
      collection_id: `deep:${CONF}:a-first`,
      paper_id: paperOne,
      arxiv_id: "2602.18473",
      path: `${CONF}/deep-2602.18473.json`,
    });
    const row2 = deepRow({
      collection_id: `deep:${CONF}:b-second`,
      paper_id: paperOne, // mismatched on purpose -- real owner is paperTwo
      arxiv_id: "2602.18474",
      path: `${CONF}/deep-2602.18474.json`,
      input_sha256: "e".repeat(64),
    });
    const entry1 = manifestEntry(paperOne, "2602.18473", "Paper One");
    const entry2 = manifestEntry(paperTwo, "2602.18474", "Paper Two");

    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: qualityManifest([row1, row2]),
    });
    vi.spyOn(dataLineage, "fetchDeepManifestBytes").mockResolvedValue({
      status: "ok",
      data: {
        raw: {
          schema_version: MANIFEST_VERSION,
          conference: CONF,
          generated_at: "2026-08-30T00:00:00Z",
          entries: [entry1, entry2],
        },
        sha256: MANIFEST_SHA,
      },
    });
    vi.spyOn(dataLineage, "fetchLineageArtifactBytes").mockResolvedValue({
      status: "error",
      error: "network boom",
    });

    await act(async () => {
      render(<ConferenceDeepPage />);
    });
    const select = await screen.findByRole("combobox", { name: /Select focus paper/i });
    const options = select.querySelectorAll("option");
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toBe("Paper One");
  });
});
