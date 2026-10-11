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
  applySuggestions,
  arxivHtmlIdFromRationale,
  buildAuditDraft,
  importAuditDraft,
  mergeFixtureEntry,
  projectOutcome,
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

function provEdge(
  src: string,
  dst: string,
  relation: string,
  method: string,
  source: string,
  rationale: string,
) {
  return {
    ...edge(src, dst, relation, rationale),
    provenance: {
      evidence: { source, kind: "citation-context", sha256: "x" },
      classification: { method, provider: null, model: null },
    },
  };
}

function evidenceLineage(): Record<string, unknown> {
  const data = lineage(6);
  const nodes = data.nodes as Record<string, unknown>[];
  nodes[0]!.venue = "ICLR";
  nodes[3]!.arxiv_id = "2102.12122";
  data.edges = [
    provEdge(
      "openalex:W0",
      "openalex:W1",
      "extends",
      "s2_context_rule",
      "semantic_scholar",
      '「P1」は…（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "We build on [3]."',
    ),
    provEdge(
      "openalex:W0",
      "openalex:W3",
      "extends",
      "s2_context_rule",
      "arxiv_html",
      '「P3」は…（arXiv HTML（arXiv:2102.12122v2）の本文の引用文から規則で判定）。引用文: "We follow ViT [13]."',
    ),
    provEdge(
      "openalex:W1",
      "openalex:W4",
      "extends",
      "s2_context_rule",
      "semantic_scholar",
      '「P4」は…（引用元の論文の要旨から規則で判定）。要旨: "We propose P4 based on P1."',
    ),
    provEdge(
      "openalex:W0",
      "openalex:W5",
      "extends",
      "foundational_allowlist",
      "semantic_scholar",
      "基礎文献リストに基づく規則。",
    ),
    provEdge(
      "openalex:W4",
      "openalex:W5",
      "supersedes",
      "title_version",
      "semantic_scholar",
      "命名パターンから置き換え。",
    ),
    provEdge(
      "openalex:W1",
      "openalex:W5",
      "baseline_only",
      "api_citation",
      "semantic_scholar",
      "参考文献リストで確認。",
    ),
  ];
  return data;
}

describe("evidence sources (R2-28: arXiv HTML, abstract, allowlist, title version, DBLP)", () => {
  it("labels each strong edge with its basis, quote and a link to check it", () => {
    const { draft } = draftFor(evidenceLineage());
    const by = (dst: string, rel = "extends") =>
      draft.relations.find((r) => r.dst === dst && r.relation === rel)!;
    expect(draft.relations).toHaveLength(5);
    const s2 = by("openalex:W1");
    expect(s2.basis).toBe("s2_context");
    expect(s2.source_url).toContain("api.semanticscholar.org");
    const html = by("openalex:W3");
    expect(html.basis).toBe("arxiv_html");
    expect(html.source_url).toBe("https://arxiv.org/html/2102.12122v2");
    expect(html.quote).toBe("We follow ViT [13].");
    const abs = by("openalex:W4");
    expect(abs.basis).toBe("citing_abstract");
    expect(abs.quote).toBe("We propose P4 based on P1.");
    expect(abs.flags).not.toContain("引用文なし");
    const allow = by("openalex:W5");
    expect(allow.basis).toBe("foundational_allowlist");
    expect(allow.flags).not.toContain("引用文なし");
    expect(by("openalex:W5", "supersedes").basis).toBe("title_version");
    const md = renderAuditSheet(draft);
    expect(md).toContain(
      "根拠: arXiv HTML 本文の引用文（[確認](https://arxiv.org/html/2102.12122v2)）",
    );
    expect(md).toContain("- 要旨: “We propose P4 based on P1.”");
    expect(md).toContain("| 強い関係の根拠 |");
    expect(md).toContain("基礎文献リスト（引用文なし） 1");
  });

  it("parses the arXiv id of an arXiv HTML rationale", () => {
    expect(arxivHtmlIdFromRationale("（arXiv HTML（arXiv:2101.03961v3）の本文）")).toBe(
      "2101.03961v3",
    );
    expect(arxivHtmlIdFromRationale("Semantic Scholar の引用文")).toBeNull();
  });

  it("marks venues that match the DBLP venue cache", () => {
    const data = evidenceLineage();
    const bytes = Buffer.from(JSON.stringify(data));
    const draft = buildAuditDraft({
      lineage: data,
      lineageBytes: bytes,
      collectionId: "theme:t",
      lineagePath: "x",
      generatedAt: "2026-10-11T00:00:00Z",
      dblpVenues: {
        "openalex:W0": { venue: "ICLR", key: "conf/iclr/X21" },
        // Stale entry: the node's venue is not DBLP's, so no mark.
        "openalex:W1": { venue: "NeurIPS", key: "conf/nips/Y20" },
        "openalex:W2": { venue: null, key: null },
      },
    });
    const w0 = draft.nodes.find((n) => n.node_id === "openalex:W0")!;
    expect(w0.venue_source).toBe("dblp");
    expect(w0.links.dblp).toBe("https://dblp.org/rec/conf/iclr/X21");
    expect(draft.nodes.filter((n) => n.venue_source === "dblp")).toHaveLength(1);
    expect(renderAuditSheet(draft)).toContain("ICLR（DBLP）");
  });
});

describe("suggestions and the projected outcome", () => {
  it("copies suggestions without touching verdicts and projects the fixture result", () => {
    const { draft } = draftFor(lineage());
    const before = projectOutcome(draft);
    expect(before.passes).toBe(false);
    expect(before.unset).toBe(5);
    const {
      draft: next,
      unknown,
      missing,
    } = applySuggestions(draft, {
      nodes: {
        "openalex:W0": { on_topic: true, metadata_ok: true, reason: "ok" },
        "openalex:W1": { on_topic: true, metadata_ok: true },
        "openalex:W2": { on_topic: false, metadata_ok: true, assessment: "doubtful", reason: "x" },
        "openalex:W9": { on_topic: true, metadata_ok: true },
      },
      relations: {
        "openalex:W0->openalex:W1:extends": { verdict: "correct", reason: "ok" },
        "openalex:W0->openalex:W2:contrasts": {
          verdict: "wrong",
          corrected_relation: "baseline_only",
          assessment: "doubtful",
          reason: "survey",
        },
      },
    });
    expect(unknown).toEqual(["node:openalex:W9"]);
    expect(missing).toEqual([]);
    expect(next.nodes.every((n) => n.on_topic === null)).toBe(true);
    expect(next.relations.every((r) => r.verdict === null)).toBe(true);
    const outcome = projectOutcome(next);
    expect(outcome.unset).toBe(0);
    expect(outcome.off_topic).toEqual(["openalex:W2"]);
    expect(outcome.wrong_relations).toEqual(["openalex:W0->openalex:W2:contrasts"]);
    expect(outcome.passes).toBe(false);
    expect(outcome.reasons.join(" ")).toContain("標本のテーマ外の割合 33.3%");
    const md = renderAuditSheet(next);
    expect(md).toContain("**不合格**");
    expect(md).toContain("誤り → baseline_only");
    // A verdict overrides the suggestion in the projection.
    next.relations.find((r) => r.relation === "contrasts")!.verdict = "correct";
    next.nodes.find((n) => n.node_id === "openalex:W2")!.on_topic = true;
    expect(projectOutcome(next).passes).toBe(true);
    expect(renderAuditSheet(next)).toContain("**合格**");
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

  it("suggest merges a suggestions file and refuses a stale one", async () => {
    const { runAuditDraftCli } = await import("../../../src/lineage/quality/auditDraftCli.js");
    const repo = mkdtempSync(join(tmpdir(), "audit-suggest-"));
    const docs = join(repo, "docs");
    mkdirSync(join(docs, "themes", "t"), { recursive: true });
    writeFileSync(join(docs, "themes", "t", "lineage.json"), JSON.stringify(lineage()));
    const policy = join(repo, "policy.json");
    writeFileSync(policy, JSON.stringify({ strong_relations: ["contrasts", "extends"] }));
    const dblp = join(repo, "dblp.json");
    writeFileSync(dblp, JSON.stringify({ entries: { "openalex:W1": { venue: null, key: null } } }));
    const io = { out: () => {}, err: () => {}, now: () => new Date("2026-10-12T00:00:00Z") };
    const outDir = join(repo, "drafts");
    expect(
      runAuditDraftCli(
        [
          "draft",
          "--theme",
          "t",
          "--out-dir",
          outDir,
          "--docs-root",
          docs,
          "--policy",
          policy,
        ].concat(["--dblp-cache", dblp]),
        repo,
        io,
      ),
    ).toBe(0);
    const draftPath = join(outDir, "t.audit-pending.json");
    const good = join(repo, "s.json");
    writeFileSync(
      good,
      JSON.stringify({
        nodes: { "openalex:W2": { on_topic: false, metadata_ok: true, assessment: "doubtful" } },
        relations: { "openalex:W0->openalex:W1:extends": { verdict: "correct", reason: "ok" } },
      }),
    );
    expect(runAuditDraftCli(["suggest", "--draft", draftPath, "--from", good], repo, io)).toBe(0);
    const merged = JSON.parse(readFileSync(draftPath, "utf8"));
    expect(
      merged.nodes.find((n: { node_id: string }) => n.node_id === "openalex:W2").suggestion,
    ).toMatchObject({ on_topic: false, assessment: "doubtful" });
    expect(readFileSync(join(outDir, "t.audit.md"), "utf8")).toContain("## 要確認の一覧");
    const stale = join(repo, "stale.json");
    writeFileSync(stale, JSON.stringify({ nodes: { "openalex:W99": { on_topic: true } } }));
    expect(runAuditDraftCli(["suggest", "--draft", draftPath, "--from", stale], repo, io)).toBe(1);
  });
});
