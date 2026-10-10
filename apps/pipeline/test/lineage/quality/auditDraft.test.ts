/**
 * auditDraft (design doc 41 D5, R2-8): draft -> edited draft -> fixtures
 * entry, and the CLI round trip through the real quality builder.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArtifact } from "@paperpilot/core";
import { describe, expect, it } from "vitest";
import {
  AuditImportError,
  buildAuditDraft,
  importAuditDraft,
  mergeFixtureEntry,
  quoteFromRationale,
  renderAuditSheet,
  sha256Hex,
} from "../../../src/lineage/quality/auditDraft.js";

function edge(src: string, dst: string, relation: string, rationale = "r") {
  return { src, dst, rel: relation, relation, conf: 0.8, confidence: 0.8, rationale };
}

function lineage(nodeCount = 3): Record<string, unknown> {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `openalex:W${i}`,
    title: i === 2 ? "A Survey of Things" : `Paper ${i}: Sub`,
    year: 2020 + i,
    authors: ["A B"],
    doi: `10.1/x${i}`,
    arxiv_id: i === 0 ? "2001.00001" : null,
    is_focus: i === 0,
  }));
  return {
    schema_version: "lineage-artifact-v1",
    root: "openalex:W0",
    nodes,
    edges: [
      edge("openalex:W0", "openalex:W1", "extends", '「P1」は… 引用文: "We build on Paper 0 [3]."'),
      edge("openalex:W0", "openalex:W2", "contrasts"),
      edge("openalex:W1", "openalex:W2", "baseline_only"),
    ],
    clusters: [],
    meta: { theme: "T", seeds: ["openalex:W0"], topic_gate: { method: "embedding+terms" } },
  };
}

function draftFor(data: Record<string, unknown>) {
  const bytes = Buffer.from(JSON.stringify(data));
  const draft = buildAuditDraft({
    lineage: data,
    lineageBytes: bytes,
    collectionId: "theme:t",
    lineagePath: "data/published/themes/t/lineage.json",
    generatedAt: "2026-10-11T00:00:00Z",
  });
  return { draft, bytes };
}

function fill(draft: ReturnType<typeof draftFor>["draft"]) {
  draft.auditor = "taichi";
  draft.audited_at = "2026-10-12T10:00:00+09:00";
  for (const n of draft.nodes) {
    n.on_topic = true;
    n.metadata_ok = true;
  }
  for (const r of draft.relations) r.verdict = "correct";
  return draft;
}

function doImport(draft: unknown, bytes: Buffer, data: unknown) {
  const draftBytes = Buffer.from(JSON.stringify(draft));
  return importAuditDraft({ draft, draftBytes, lineage: data, lineageBytes: bytes });
}

describe("buildAuditDraft", () => {
  it("lists every node and only the strong-claim edges, with null verdicts", () => {
    const data = lineage();
    const { draft, bytes } = draftFor(data);
    expect(draft.input_sha256).toBe(sha256Hex(bytes));
    expect(draft.strong_relations).toEqual(["contrasts", "supersedes", "extends", "successor"]);
    expect(draft.nodes.map((n) => n.node_id)).toEqual([
      "openalex:W0",
      "openalex:W1",
      "openalex:W2",
    ]);
    expect(draft.nodes.every((n) => n.on_topic === null && n.metadata_ok === null)).toBe(true);
    expect(draft.relations.map((r) => `${r.src}->${r.dst}:${r.relation}`)).toEqual([
      "openalex:W0->openalex:W2:contrasts",
      "openalex:W0->openalex:W1:extends",
    ]);
    expect(draft.relations.every((r) => r.verdict === null)).toBe(true);
    const ext = draft.relations.find((r) => r.relation === "extends")!;
    expect(ext.quote).toBe("We build on Paper 0 [3].");
    const con = draft.relations.find((r) => r.relation === "contrasts")!;
    expect(con.flags).toContain("引用側がサーベイらしい");
    expect(con.flags).toContain("引用文なし");
    const root = draft.nodes[0]!;
    expect(root.links.openalex).toBe("https://openalex.org/W0");
    expect(root.links.arxiv).toBe("https://arxiv.org/abs/2001.00001");
    expect(root.why_included).toContain("フォーカス");
  });

  it("renders a Japanese sheet with nodes, quotes and the doubtful list", () => {
    const { draft } = draftFor(lineage());
    draft.relations[0]!.suggestion = {
      verdict: "wrong",
      corrected_relation: "baseline_only",
      assessment: "doubtful",
      reason: "背景の引用",
    };
    const md = renderAuditSheet(draft);
    expect(md).toContain("# 監査シート: T（theme:t）");
    expect(md).toContain("## ノード（3 件）");
    expect(md).toContain("## 強い主張の関係（2 件）");
    expect(md).toContain("We build on Paper 0 [3].");
    expect(md).toContain("## 要確認の一覧（第二審査）");
    expect(md).toContain("誤り → baseline_only");
  });

  it("extracts the quote from a rationale", () => {
    expect(quoteFromRationale('理由。引用文: "a, b."')).toBe("a, b.");
    expect(quoteFromRationale("引用文はない。")).toBeNull();
  });
});

describe("importAuditDraft", () => {
  it("refuses an unedited draft and lists every missing field", () => {
    const data = lineage();
    const { draft, bytes } = draftFor(data);
    try {
      doImport(draft, bytes, data);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuditImportError);
      const problems = (e as AuditImportError).problems;
      expect(problems).toContain("auditor is empty");
      expect(problems).toContain("node openalex:W1: on_topic not set");
      expect(problems).toContain("relation openalex:W0->openalex:W2:contrasts: verdict not set");
    }
  });

  it("refuses a draft made for different artifact bytes", () => {
    const data = lineage();
    const { draft } = draftFor(data);
    fill(draft);
    expect(() => doImport(draft, Buffer.from(`${JSON.stringify(data)} `), data)).toThrow(
      /input_sha256 mismatch/,
    );
  });

  it("refuses a draft missing a strong edge, and corrected_relation on 'correct'", () => {
    const data = lineage();
    const { draft, bytes } = draftFor(data);
    fill(draft);
    draft.relations[0]!.corrected_relation = "extends";
    draft.relations.pop();
    expect(() => doImport(draft, bytes, data)).toThrow(
      /strong relation missing from draft: openalex:W0->openalex:W1:extends/,
    );
  });

  it("builds a schema-valid fixtures entry with auditor/date, metadata and edge verdicts", () => {
    const data = lineage();
    const { draft, bytes } = draftFor(data);
    fill(draft);
    draft.nodes[2]!.metadata_ok = false;
    draft.nodes[2]!.note = "年が違う";
    const contrasts = draft.relations.find((r) => r.relation === "contrasts")!;
    contrasts.verdict = "wrong";
    contrasts.corrected_relation = "baseline_only";
    const { entry, warnings, stats } = doImport(draft, bytes, data);
    expect(entry.reviewer).toBe("taichi");
    expect(entry.reviewed_at).toBe("2026-10-12T10:00:00+09:00");
    expect(entry.input_sha256).toBe(sha256Hex(bytes));
    expect(entry.focus_labels).toEqual([
      { node_id: "openalex:W0", on_topic: true, metadata_ok: true },
    ]);
    expect(entry.sample_labels).toHaveLength(3);
    expect(entry.sample_labels[2]).toEqual({
      node_id: "openalex:W2",
      on_topic: true,
      metadata_ok: false,
      note: "年が違う",
    });
    expect(entry.edge_labels).toContainEqual({
      src: "openalex:W0",
      dst: "openalex:W2",
      relation: "contrasts",
      verdict: "wrong",
      corrected_relation: "baseline_only",
    });
    expect(stats).toMatchObject({ metadata_wrong: 1, wrong_relations: 1 });
    expect(warnings.some((w) => w.includes("judged wrong"))).toBe(true);
    const doc = mergeFixtureEntry(
      { schema_version: "lineage-audit-fixtures-v1", collections: [] },
      entry,
    );
    const check = validateArtifact("lineage-audit-fixtures-v1", doc);
    expect(check.ok, JSON.stringify(check)).toBe(true);
  });

  it("only uses suggestions when the auditor opts in", () => {
    const data = lineage();
    const { draft, bytes } = draftFor(data);
    draft.auditor = "taichi";
    draft.audited_at = "2026-10-12T10:00:00Z";
    for (const n of draft.nodes) {
      n.suggestion = { on_topic: true, metadata_ok: true, assessment: "looks_right", reason: "" };
    }
    for (const r of draft.relations) {
      r.suggestion = {
        verdict: "correct",
        corrected_relation: null,
        assessment: "looks_right",
        reason: "",
      };
    }
    expect(() => doImport(draft, bytes, data)).toThrow(AuditImportError);
    draft.accept_suggestions_for_unset = true;
    draft.nodes[1]!.on_topic = false; // an explicit verdict wins over the suggestion
    const { entry } = doImport(draft, bytes, data);
    expect(entry.sample_labels.find((l) => l.node_id === "openalex:W1")!.on_topic).toBe(false);
    expect(entry.edge_labels.every((l) => l.verdict === "correct")).toBe(true);
  });

  it("keeps every negative node verdict in a 20-row sample of a larger graph", () => {
    const data = lineage(25);
    const { draft, bytes } = draftFor(data);
    fill(draft);
    draft.nodes.find((n) => n.node_id === "openalex:W24")!.on_topic = false;
    draft.nodes.find((n) => n.node_id === "openalex:W17")!.metadata_ok = false;
    const { entry } = doImport(draft, bytes, data);
    expect(entry.sample_labels).toHaveLength(20);
    const ids = entry.sample_labels.map((l) => l.node_id);
    expect(ids).toContain("openalex:W24");
    expect(ids).toContain("openalex:W17");
    expect(new Set(ids).size).toBe(20);
  });
});

describe("auditDraftCli round trip", () => {
  it("draft -> edit -> import --write -> the quality builder audits the theme", async () => {
    const { runAuditDraftCli } = await import("../../../src/lineage/quality/auditDraftCli.js");
    const repo = mkdtempSync(join(tmpdir(), "audit-draft-"));
    const docs = join(repo, "docs");
    mkdirSync(join(docs, "themes", "t"), { recursive: true });
    const data = lineage();
    writeFileSync(join(docs, "themes", "t", "lineage.json"), JSON.stringify(data));
    writeFileSync(join(docs, "conferences.json"), "[]");
    writeFileSync(
      join(docs, "themes", "themes-manifest.json"),
      JSON.stringify([{ slug: "t", theme: "T" }]),
    );
    const policy = join(repo, "policy.json");
    writeFileSync(
      policy,
      JSON.stringify({ strong_relations: ["contrasts", "extends"], theme_max_age_days: 90 }),
    );
    const fixtures = join(repo, "fixtures.json");
    writeFileSync(
      fixtures,
      JSON.stringify({ schema_version: "lineage-audit-fixtures-v1", collections: [] }),
    );
    const out: string[] = [];
    const io = {
      out: (t: string) => out.push(t),
      err: (t: string) => out.push(t),
      now: () => new Date("2026-10-12T00:00:00Z"),
    };
    const outDir = join(repo, "drafts");
    expect(
      runAuditDraftCli(
        ["draft", "--theme", "t", "--out-dir", outDir, "--docs-root", docs, "--policy", policy],
        repo,
        io,
      ),
    ).toBe(0);
    const draftPath = join(outDir, "t.audit-pending.json");
    expect(readFileSync(join(outDir, "t.audit.md"), "utf8")).toContain("監査シート");
    const common = [
      "--draft",
      draftPath,
      "--docs-root",
      docs,
      "--policy",
      policy,
      "--fixtures",
      fixtures,
    ];
    expect(runAuditDraftCli(["import", ...common], repo, io)).toBe(1);
    const draft = fill(JSON.parse(readFileSync(draftPath, "utf8")));
    writeFileSync(draftPath, JSON.stringify(draft));
    expect(runAuditDraftCli(["import", ...common, "--write"], repo, io)).toBe(0);
    const written = JSON.parse(readFileSync(fixtures, "utf8"));
    expect(written.collections).toHaveLength(1);
    expect(written.collections[0].reviewer).toBe("taichi");
    expect(out.join("")).toMatch(/dry-run: golden_fixture=(passed|failed)/);
    expect(runAuditDraftCli(["nope"], repo, io)).toBe(2);
  });
});
