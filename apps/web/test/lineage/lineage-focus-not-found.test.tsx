// @vitest-environment jsdom
//
// P2 review LOW-1 -- app/[conf]/lineage/page.tsx used to branch render
// on a separately-stored `focusNotFound` boolean (the inverse of
// `resolveLineageFocusGate`'s own `mount` field), rather than on
// `gate.mount` itself. Ported fix stores `gate.mount` directly and
// renders `{focusMount ? <LineageGraph/> : notice}` -- this pins the
// one behaviour the review named: an eligible conference row with an
// unresolvable `?focus=` must show the "not found" alert and must NOT
// mount the graph.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConferenceLineagePage from "../../app/[conf]/lineage/page";
import * as dataLineage from "../../lib/data-lineage";
import { ARTIFACT_VERSION, QUALITY_VERSION, type QualityRow } from "../../lib/lineage/core";

vi.mock("next/navigation", () => ({
  useParams: () => ({ conf: "test-2026" }),
}));

const ROW: QualityRow = {
  collection_id: "conference:test-2026",
  kind: "conference",
  slug: "test-2026",
  label: "Test 2026",
  path: "test-2026/lineage.json",
  availability: "ready",
  audit_status: "passed",
  freshness: "fresh",
  generated_at: "2026-08-30T00:00:00Z",
  snapshot_date: null,
  node_count: 2,
  edge_count: 1,
  artifact_schema_version: "lineage-artifact-v1",
  input_sha256: "b".repeat(64),
  audit: {
    fixture_sha256: "9".repeat(64),
    evaluated_at: "2026-08-30T00:00:00Z",
    actor: "ci:audit-v1",
    checks: [
      { name: "artifact_contract_v1", status: "passed", observed: 0, expected: 0, evidence: [] },
      {
        name: "golden_fixture",
        status: "passed",
        observed: "fixture-sha",
        expected: "matching frozen fixture",
        evidence: [],
      },
    ],
  },
};

const PAPER_ID = "1".repeat(40);

const ARTIFACT = {
  schema_version: ARTIFACT_VERSION,
  root: "root",
  nodes: [
    {
      id: "root",
      title: "Root",
      is_focus: true,
      seed_paper_id: PAPER_ID,
      aliases: [["semantic_scholar", "root"]],
    },
    { id: "z-child", title: "Child", is_focus: false },
  ],
  edges: [
    {
      src: "root",
      dst: "z-child",
      rel: "extends",
      relation: "extends",
      conf: 0.8,
      confidence: 0.8,
      rationale: "Specific evidence",
      provenance: {
        producer: { name: "paperpilot", version: "1" },
        evidence: { source: "s2", kind: "citation", sha256: "0".repeat(64) },
        classification: {
          method: "citation_heuristic",
          provider: null,
          model: null,
          prompt_version: null,
          schema_version: "1",
        },
      },
    },
  ],
  clusters: [],
  meta: { kind: "conference", generated_at: "2026-08-30T00:00:00Z" },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/test-2026/lineage/");
});

describe("conference lineage page: unresolved ?focus= (P2 review LOW-1)", () => {
  it("shows the not-found alert and does not mount the graph for an unknown ?focus=", async () => {
    window.history.replaceState(null, "", "/test-2026/lineage/?focus=does-not-exist");
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: {
        schema_version: QUALITY_VERSION,
        as_of: "2026-08-30T00:00:00Z",
        audit_version: "audit-v1",
        collections: [ROW],
      },
    });
    vi.spyOn(dataLineage, "fetchLineageArtifactBytes").mockResolvedValue({
      status: "ok",
      data: { raw: ARTIFACT, sha256: "b".repeat(64) },
    });

    await act(async () => {
      render(<ConferenceLineagePage />);
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("指定された論文IDはこの監査済み系譜にありません。");
    expect(screen.queryByRole("img", { name: /lineage graph/i })).toBeNull();
  });

  it("mounts the graph (no alert) when ?focus= is absent", async () => {
    window.history.replaceState(null, "", "/test-2026/lineage/");
    vi.spyOn(dataLineage, "fetchLineageQualityManifest").mockResolvedValue({
      status: "ok",
      data: {
        schema_version: QUALITY_VERSION,
        as_of: "2026-08-30T00:00:00Z",
        audit_version: "audit-v1",
        collections: [ROW],
      },
    });
    vi.spyOn(dataLineage, "fetchLineageArtifactBytes").mockResolvedValue({
      status: "ok",
      data: { raw: ARTIFACT, sha256: "b".repeat(64) },
    });

    await act(async () => {
      render(<ConferenceLineagePage />);
    });

    await screen.findByText(/（監査済み）/);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
