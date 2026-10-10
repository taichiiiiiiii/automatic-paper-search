/**
 * R2-6 (design 41 D3): evidence-classified rate, the theme CLI's exit 5
 * with its `::error::` report and `--result-json`, and the pending-retry
 * state round-trip (library + CLI).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildThemeLineageDeps } from "../../../src/lineage/theme/build.js";
import {
  DegradedClassificationError,
  EXIT_DEGRADED_CLASSIFICATION,
  evidenceClassifiedRate,
} from "../../../src/lineage/theme/classificationGate.js";
import { resolveMinClassifiedRate, runThemeCli } from "../../../src/lineage/theme/cli.js";
import {
  emptyPending,
  loadPending,
  QUOTA_REASON,
  recordResults,
  retryThemes,
  savePending,
} from "../../../src/lineage/theme/regenPending.js";
import { runRegenPendingCli } from "../../../src/lineage/theme/regenPendingCli.js";

const tmp = () => mkdtempSync(join(tmpdir(), "r26-"));

describe("evidenceClassifiedRate (provider-agnostic)", () => {
  it("counts every evidence method as classified and only year/citation guesses as not", () => {
    const r = evidenceClassifiedRate({
      llm: 5,
      intent_map: 2,
      context_pattern: 1,
      title_version: 1,
      foundational_allowlist: 1,
      citation_heuristic: 2,
      year_cite: 0,
    });
    expect(r).toMatchObject({ classified: 10, guessed: 2, total: 12 });
    expect(r.ratio).toBeCloseTo(10 / 12);
    expect(r.byMethod).toEqual({
      llm: 5,
      intent_map: 2,
      context_pattern: 1,
      title_version: 1,
      foundational_allowlist: 1,
    });
  });

  it("S2-intent-only lineages pass without any LLM", () => {
    expect(evidenceClassifiedRate({ intent_map: 9, citation_heuristic: 1 }).ratio).toBeCloseTo(0.9);
  });

  it("has no ratio with no edges", () => {
    expect(evidenceClassifiedRate({}).ratio).toBeNull();
  });
});

describe("resolveMinClassifiedRate", () => {
  it("flag > policy key > 0.8 default; rejects out-of-range values", () => {
    const dir = tmp();
    const policy = join(dir, "p.json");
    writeFileSync(policy, JSON.stringify({ theme_min_evidence_classified_rate: 0.6 }));
    expect(resolveMinClassifiedRate(0.9, policy)).toBe(0.9);
    expect(resolveMinClassifiedRate(null, policy)).toBe(0.6);
    expect(resolveMinClassifiedRate(null, join(dir, "missing.json"))).toBe(0.8);
    expect(resolveMinClassifiedRate(null, null)).toBe(0.8);
    expect(() => resolveMinClassifiedRate(1.5, null)).toThrow();
    writeFileSync(policy, JSON.stringify({ theme_min_evidence_classified_rate: "x" }));
    expect(() => resolveMinClassifiedRate(null, policy)).toThrow();
  });

  it("the repo policy pins 0.8", () => {
    const repoPolicy = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "..",
      "data",
      "config",
      "lineage-quality-policy-v1.json",
    );
    expect(resolveMinClassifiedRate(null, repoPolicy)).toBe(0.8);
  });
});

const usage = (daily: boolean) => [
  {
    provider: "groq",
    model: "groq:openai/gpt-oss-120b",
    stats: {
      calls: 40,
      ok: 10,
      failed: 30,
      latched: daily,
      latchReason: daily ? "daily rate limit exhausted (429, reset in 3600s)" : null,
      dailyLimitHit: daily,
    },
    summary: "groq summary: model=openai/gpt-oss-120b, calls=40",
  },
  {
    provider: "gemini",
    model: "gemini:gemini-2.5-flash",
    stats: null,
    summary: null,
  },
];

describe("theme CLI gate (exit 5)", () => {
  let out: string[];
  afterEach(() => vi.restoreAllMocks());
  const capture = () => {
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
  };
  const deps = {} as BuildThemeLineageDeps;

  it("passes the resolved threshold to the build and maps a degraded build to exit 5 with an ::error:: report and result JSON", async () => {
    capture();
    const dir = tmp();
    const resultPath = join(dir, "r.json");
    let seenThreshold: unknown;
    let calls = 0;
    const rc = await runThemeCli(
      ["--theme", "Graph Nets", "--auto-expand", "--result-json", resultPath],
      {
        deps,
        policyPath: null,
        buildFn: async (opts) => {
          calls += 1;
          seenThreshold = opts.minClassifiedRate;
          throw new DegradedClassificationError(
            "Graph Nets",
            evidenceClassifiedRate({ llm: 3, intent_map: 1, citation_heuristic: 6 }),
            0.8,
            usage(true),
          );
        },
      },
    );
    expect(rc).toBe(EXIT_DEGRADED_CLASSIFICATION);
    expect(rc).toBe(5);
    expect(calls).toBe(1); // no auto-expand retry on a degraded build
    expect(seenThreshold).toBe(0.8);
    const text = out.join("");
    const errLine = text.split("\n").find((l) => l.startsWith("::error::")) ?? "";
    expect(errLine).toContain('theme "Graph Nets"');
    expect(errLine).toContain("40.0% of edges (4/10");
    expect(errLine).toContain("evidence: intent_map=1, llm=3");
    expect(errLine).toContain("year/citation guesses: 6");
    expect(errLine).toContain("below the 80.0% threshold");
    expect(errLine).toContain("previous build retained");
    expect(errLine).toContain("LLM daily limit hit: yes");
    expect(errLine).toContain("groq:openai/gpt-oss-120b calls=40 ok=10 failed=30, latched: daily");
    expect(text).toContain("groq summary: model=openai/gpt-oss-120b, calls=40");
    const result = JSON.parse(readFileSync(resultPath, "utf-8"));
    expect(result).toMatchObject({
      schema_version: "theme-run-result-v1",
      theme: "Graph Nets",
      exit_code: 5,
      status: "degraded_classification",
      daily_limit_hit: true,
      classified_rate: 0.4,
      classified_edges: 4,
      total_edges: 10,
      threshold: 0.8,
    });
  });

  it("reports 'daily limit hit: no' when the degradation is not quota-related", async () => {
    capture();
    const rc = await runThemeCli(["--theme", "Graph Nets", "--min-classified-rate", "0.9"], {
      deps,
      buildFn: async (opts) => {
        expect(opts.minClassifiedRate).toBe(0.9);
        throw new DegradedClassificationError(
          "Graph Nets",
          evidenceClassifiedRate({ llm: 8, citation_heuristic: 2 }),
          0.9,
          usage(false),
        );
      },
    });
    expect(rc).toBe(5);
    expect(out.join("")).toContain("LLM daily limit hit: no");
  });

  it("rejects an out-of-range --min-classified-rate with exit 2", async () => {
    capture();
    expect(
      await runThemeCli(["--theme", "Graph Nets", "--min-classified-rate", "2"], {
        deps,
        buildFn: async () => "never",
      }),
    ).toBe(2);
  });

  it("writes an ok result on success", async () => {
    capture();
    const dir = tmp();
    const outPath = join(dir, "lineage.json");
    writeFileSync(outPath, JSON.stringify({ nodes: [], edges: [{}] }));
    const resultPath = join(dir, "r.json");
    const rc = await runThemeCli(["--theme", "Graph Nets", "--result-json", resultPath], {
      deps,
      policyPath: null,
      buildFn: async () => outPath,
    });
    expect(rc).toBe(0);
    expect(JSON.parse(readFileSync(resultPath, "utf-8"))).toMatchObject({
      status: "ok",
      exit_code: 0,
      daily_limit_hit: false,
    });
  });
});

describe("regen-pending state", () => {
  const AT1 = "2026-10-10T09:17:00Z";
  const AT2 = "2026-10-11T09:17:00Z";

  it("round-trips: quota-degraded -> pending, retried, success clears it", () => {
    const dir = tmp();
    const file = join(dir, "regen-pending.json");
    expect(loadPending(file)).toEqual(emptyPending());
    let s = recordResults(
      loadPending(file),
      [
        { theme: "GNN", status: "degraded_classification", daily_limit_hit: true, message: "m" },
        { theme: "ViT", status: "degraded_classification", daily_limit_hit: false },
        { theme: "RAG", status: "ok" },
        { theme: "Diffusion", status: "incomplete" },
      ],
      AT1,
    );
    savePending(file, s);
    s = loadPending(file);
    expect(s.themes).toEqual([
      {
        theme: "GNN",
        reason: QUOTA_REASON,
        attempts: 1,
        first_failed_at: AT1,
        last_attempt_at: AT1,
        message: "m",
      },
    ]);
    expect(retryThemes(s)).toEqual(["GNN"]);

    s = recordResults(
      s,
      [{ theme: "GNN", status: "degraded_classification", daily_limit_hit: true }],
      AT2,
    );
    expect(s.themes[0]).toMatchObject({ attempts: 2, first_failed_at: AT1, last_attempt_at: AT2 });
    expect(retryThemes(s, 2)).toEqual([]); // attempt cap

    s = recordResults(s, [{ theme: "GNN", status: "ok" }], AT2);
    expect(s.themes).toEqual([]);
  });

  it("a pending theme failing for another reason stops being retried", () => {
    let s = recordResults(
      emptyPending(),
      [{ theme: "GNN", status: "degraded_classification", daily_limit_hit: true }],
      AT1,
    );
    s = recordResults(s, [{ theme: "GNN", status: "incomplete" }], AT2);
    expect(s.themes[0]?.reason).toBe("incomplete");
    expect(retryThemes(s)).toEqual([]);
  });

  it("serialization is deterministic and a foreign file reads as empty", () => {
    const dir = tmp();
    const file = join(dir, "p.json");
    const s = recordResults(
      emptyPending(),
      [
        { theme: "b", status: "degraded_classification", daily_limit_hit: true },
        { theme: "a", status: "degraded_classification", daily_limit_hit: true },
      ],
      AT1,
    );
    savePending(file, s);
    const raw = readFileSync(file, "utf-8");
    expect(raw.indexOf('"theme": "a"')).toBeLessThan(raw.indexOf('"theme": "b"'));
    writeFileSync(file, JSON.stringify({ schema_version: "other", themes: [{}] }));
    expect(loadPending(file)).toEqual(emptyPending());
  });

  it("CLI: record folds result files and writes the summary; list prints the retry themes", () => {
    const dir = tmp();
    const results = join(dir, "results");
    const pending = join(dir, "regen-pending.json");
    const summary = join(dir, "summary.md");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mkdirSync(results);
    writeFileSync(
      join(results, "1.json"),
      JSON.stringify({ theme: "GNN", status: "degraded_classification", daily_limit_hit: true }),
    );
    writeFileSync(
      join(results, "2.json"),
      JSON.stringify({ theme: "ViT", status: "degraded_classification", daily_limit_hit: false }),
    );
    writeFileSync(join(results, "3.json"), "{truncated");
    expect(
      runRegenPendingCli([
        "record",
        "--pending",
        pending,
        "--results-dir",
        results,
        "--at",
        AT1,
        "--summary",
        summary,
      ]),
    ).toBe(0);
    const md = readFileSync(summary, "utf-8");
    expect(md).toContain("- GNN: LLM daily limit hit — queued for automatic retry");
    expect(md).toContain("- ViT: not quota-related — needs a look");
    expect(md).toContain("Pending automatic retry (llm_quota): GNN");
    const printed: string[] = [];
    vi.restoreAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      printed.push(String(c));
      return true;
    });
    expect(runRegenPendingCli(["list", "--pending", pending])).toBe(0);
    expect(printed.join("")).toBe("GNN\n");
    vi.restoreAllMocks();
    expect(
      runRegenPendingCli(["record", "--pending", pending, "--results-dir", results, "--at", "now"]),
    ).toBe(2);
  });
});
