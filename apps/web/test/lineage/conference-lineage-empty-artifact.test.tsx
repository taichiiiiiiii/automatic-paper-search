// @vitest-environment jsdom
//
// P2 review LOW -- app/[conf]/lineage/page.tsx must not show the
// "（監査済み）" ready heading (nor mount <LineageGraph>) for an
// EMPTY audited artifact (root: null, zero nodes). Ported from
// docs/assets/lineage.js `init`'s `if (!state.data.root) { ...; return; }`,
// which sits before the lines that unhide the ready UI -- an empty
// artifact must look exactly like "not ready yet", not like a
// successfully-audited empty graph.
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
  node_count: 0,
  edge_count: 0,
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

const EMPTY_ARTIFACT = {
  schema_version: ARTIFACT_VERSION,
  root: null,
  nodes: [],
  edges: [],
  clusters: [],
  meta: {},
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/test-2026/lineage/");
});

describe("conference lineage page: empty artifact (P2 review LOW)", () => {
  it("does not show the (監査済み) ready heading or mount the graph for a root:null artifact", async () => {
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
      data: { raw: EMPTY_ARTIFACT, sha256: "b".repeat(64) },
    });

    await act(async () => {
      render(<ConferenceLineagePage />);
    });
    await screen.findByText("公開監査を待っています");

    expect(screen.queryByText(/（監査済み）/)).toBeNull();
    expect(screen.queryByRole("img", { name: /lineage graph/i })).toBeNull();
  });
});
