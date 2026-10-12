/**
 * System test (d): failure injection. Every external source the pipeline
 * reads is made to answer 5xx / 429 / a malformed body / a timeout, one at
 * a time, against the REAL CLIs. The contract (CLAUDE.md, design 41 D3):
 * published data is never corrupted — the previous files stay
 * byte-identical and the run exits non-zero or says explicitly that the
 * source was skipped and is left for a re-run. Optional enrichments
 * (GitHub stars) may degrade, but never change the graph.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FaultRule } from "./support/fixtureFetch.js";
import { describeRun, runCli } from "./support/runCli.js";
import { createSandbox, type Sandbox, SYSTEM_FIXTURES } from "./support/sandbox.js";
import {
  CONF,
  emptyPublishedTree,
  FEEDS_ARGS,
  FEEDS_DIR,
  feedsSandbox,
  THEME_ARGS,
  THEME_DIR,
} from "./support/scenarios.js";

type Snapshot = Record<string, string>;

/** sha1 of every file under `rels` (relative to the sandbox root). */
function snapshot(sb: Sandbox, rels: string[] = ["data"]): Snapshot {
  const out: Snapshot = {};
  const walk = (p: string): void => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p)) walk(join(p, f));
    } else {
      out[p.slice(sb.root.length + 1)] = createHash("sha1").update(readFileSync(p)).digest("hex");
    }
  };
  for (const r of rels) walk(sb.path(r));
  return out;
}

function changed(a: Snapshot, b: Snapshot): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
}

const FAULTS: [string, Omit<FaultRule, "match">][] = [
  ["503", { kind: "status", status: 503 }],
  ["429", { kind: "status", status: 429, headers: { "retry-after": "1" } }],
  ["malformed JSON", { kind: "malformed" }],
  ["timeout", { kind: "timeout" }],
];

// ---------------------------------------------------------------- theme --

describe("failure injection: theme lineage build", () => {
  let sb: Sandbox;
  let before: Snapshot;
  beforeAll(() => {
    sb = createSandbox({ copyData: [THEME_DIR] });
    before = snapshot(sb);
  });
  afterAll(() => sb?.cleanup());

  for (const host of ["api.openalex.org", "api.semanticscholar.org"]) {
    for (const [name, fault] of FAULTS) {
      it(`${host} ${name}: refuses to publish, previous lineage kept`, async () => {
        const result = sb.path("..", "result.json");
        const run = await runCli(
          sb,
          "lineage/theme/cli.ts",
          [...THEME_ARGS, "--result-json", result],
          {
            fixtures: ["theme-s2-counts", "theme-http"],
            faults: [{ match: host, ...fault }],
          },
        );
        expect(
          run.requests.some((r) => r.outcome === "fault"),
          describeRun(run),
        ).toBe(true);
        expect(run.code, describeRun(run)).not.toBe(0);
        const res = JSON.parse(readFileSync(result, "utf8"));
        expect(["incomplete", "zero_edges", "degraded_classification"]).toContain(res.status);
        expect(run.stderr).toMatch(/left untouched/);
        // Published data is byte-identical. Only answers that DID arrive
        // may be cached; nothing is cached for the failing source (a cached
        // "S2 has no such paper" would hide the outage on the next run).
        const diff = changed(before, snapshot(sb));
        expect(diff.filter((p) => !p.startsWith("data/state/lineage-cache/"))).toEqual([]);
        if (host.includes("semanticscholar")) {
          expect(diff.filter((p) => /\/(s2expand_|s2seedrefs_|s2_references)/.test(p))).toEqual([]);
        } else {
          expect(diff.filter((p) => /\/(references|citations|search)_/.test(p))).toEqual([]);
        }
        before = snapshot(sb);
      });
    }
  }

  it("api.github.com 503 (optional stars): same graph, stars degrade, exit 0", async () => {
    const ok = createSandbox({ copyData: [THEME_DIR] });
    const bad = createSandbox({ copyData: [THEME_DIR] });
    try {
      const good = await runCli(ok, "lineage/theme/cli.ts", THEME_ARGS, {
        fixtures: ["theme-s2-counts", "theme-http"],
      });
      const degraded = await runCli(bad, "lineage/theme/cli.ts", THEME_ARGS, {
        fixtures: ["theme-s2-counts", "theme-http"],
        faults: [{ match: "api.github.com", kind: "status", status: 503 }],
      });
      expect(good.code, describeRun(good)).toBe(0);
      expect(degraded.code, describeRun(degraded)).toBe(0);
      expect(degraded.stderr).toMatch(/github search unavailable/);
      const shape = (s: Sandbox) => {
        const lin = JSON.parse(readFileSync(s.path(THEME_DIR, "lineage.json"), "utf8"));
        return {
          nodes: lin.nodes.map((n: { id: string }) => n.id),
          edges: lin.edges.map(
            (e: { src: string; dst: string; rel: string }) => `${e.src}>${e.dst}:${e.rel}`,
          ),
        };
      };
      expect(shape(bad)).toEqual(shape(ok));
    } finally {
      ok.cleanup();
      bad.cleanup();
    }
  });
});

// ------------------------------------------------------------ conference --

const FX = { fixtures: ["conference-iclr-2025"] };
const LISTING = "proceedings.iclr.cc";

describe("failure injection: conference catalog", () => {
  const listing = readFileSync(
    join(SYSTEM_FIXTURES, "conference-iclr-2025/bodies/proceedings-listing.html"),
    "utf8",
  );
  const listingFaults: [string, FaultRule][] = [
    ["503", { match: LISTING, kind: "status", status: 503 }],
    ["timeout", { match: LISTING, kind: "timeout" }],
    ["non-HTML body", { match: LISTING, kind: "malformed" }],
    [
      "body cut off mid-transfer",
      {
        match: LISTING,
        kind: "malformed",
        status: 200,
        headers: { "content-type": "text/html" },
        body: listing.slice(0, Math.floor(listing.length / 2)),
      },
    ],
  ];

  describe("new edition (nothing published yet)", () => {
    let sb: Sandbox;
    beforeAll(() => {
      sb = createSandbox({ files: emptyPublishedTree() });
    });
    afterAll(() => sb?.cleanup());
    for (const [name, fault] of listingFaults) {
      it(`listing ${name}: approveCli writes nothing and exits 1`, async () => {
        const before = snapshot(sb);
        const run = await runCli(
          sb,
          "conference/watch/approveCli.ts",
          ["--edition", CONF, "--execute"],
          {
            ...FX,
            faults: [fault],
          },
        );
        expect(run.code, describeRun(run)).toBe(1);
        expect(run.stdout).toMatch(/Nothing written|Nothing is committed/);
        expect(changed(before, snapshot(sb))).toEqual([]);
      });
    }
  });

  describe("existing edition", () => {
    let sb: Sandbox;
    let published: Snapshot;
    const refreshPages = () => runCli(sb, "catalog/buildPagesCli.ts", [], FX);

    beforeAll(async () => {
      sb = createSandbox({ files: emptyPublishedTree() });
      for (const [cli, args] of [
        ["conference/watch/approveCli.ts", ["--edition", CONF, "--execute"]],
        ["catalog/linkExternalIdsCli.ts", ["--conference", CONF]],
        ["catalog/resolveAbstractReplacementsCli.ts", ["--conference", CONF]],
        ["catalog/buildPagesCli.ts", []],
      ] as const) {
        const run = await runCli(sb, cli, [...args], FX);
        if (run.code !== 0) throw new Error(`${cli}\n${describeRun(run)}`);
      }
      published = snapshot(sb, ["data/published"]);
    });
    afterAll(() => sb?.cleanup());

    for (const [name, fault] of listingFaults) {
      it(`re-collect, listing ${name}: inputs and published catalog kept`, async () => {
        const before = snapshot(sb);
        const run = await runCli(
          sb,
          "conference/watch/approveCli.ts",
          ["--edition", CONF, "--execute"],
          {
            ...FX,
            faults: [fault],
          },
        );
        expect(run.code, describeRun(run)).toBe(1);
        expect(changed(before, snapshot(sb))).toEqual([]);
      });
    }

    for (const [name, fault] of FAULTS) {
      it(`DBLP SPARQL ${name}: external_ids.json kept, exit 1`, async () => {
        const before = snapshot(sb);
        const run = await runCli(sb, "catalog/linkExternalIdsCli.ts", ["--conference", CONF], {
          ...FX,
          faults: [{ match: "sparql.dblp.org", ...fault }],
        });
        expect(run.code, describeRun(run)).toBe(1);
        expect(run.stdout + run.stderr).toMatch(/nothing written/);
        expect(changed(before, snapshot(sb))).toEqual([]);
      });
    }

    for (const host of ["export.arxiv.org", "api.semanticscholar.org"]) {
      for (const [name, fault] of FAULTS) {
        it(`abstract resolver, ${host} ${name}: explicit re-run note, published abstracts kept`, async () => {
          const run = await runCli(
            sb,
            "catalog/resolveAbstractReplacementsCli.ts",
            ["--conference", CONF, "--retry-none"],
            { ...FX, faults: [{ match: host, ...fault }] },
          );
          expect(run.code, describeRun(run)).toBe(0);
          expect(run.stdout).toMatch(/left for a re-run/);
          const counts = JSON.parse(
            readFileSync(sb.path(`data/inputs/${CONF}/abstract_replacements.json`), "utf8"),
          ).counts;
          // Every licensed abstract found before survives the failed retry.
          expect(counts.arxiv).toBe(13);
          expect(counts.s2_tldr).toBe(4);
          const pages = await refreshPages();
          expect(pages.code, describeRun(pages)).toBe(0);
          expect(changed(published, snapshot(sb, ["data/published"]))).toEqual([]);
        });
      }
    }
  });
});

// ----------------------------------------------------------------- feeds --

describe("failure injection: theme feeds", () => {
  let sb: Sandbox;
  let lineageSha: string;
  // TTL 0: every committed HF cache entry is stale, so HF is asked again.
  const args = [...FEEDS_ARGS, "--hf-ttl-days", "0"];

  beforeAll(() => {
    sb = feedsSandbox(["data/state/hf-papers"]);
    lineageSha = snapshot(sb)[`${FEEDS_DIR}/lineage.json`] as string;
  });
  afterAll(() => sb?.cleanup());

  for (const [name, fault] of FAULTS) {
    it(`OpenAlex ${name}: new-papers.json and feed.xml kept, exit 4`, async () => {
      const before = snapshot(sb);
      const run = await runCli(
        sb,
        "lineage/theme/feed/themeFeedsCli.ts",
        [...args, "--what", "new-papers"],
        {
          fixtures: ["theme-feeds-http"],
          faults: [{ match: "api.openalex.org", ...fault }],
        },
      );
      expect(run.code, describeRun(run)).toBe(4);
      expect(run.stdout).toMatch(/new-papers FAILED, previous files kept/);
      expect(changed(before, snapshot(sb))).toEqual([]);
    });
  }

  for (const [name, fault] of FAULTS) {
    it(`Hugging Face ${name}: exit 4, no code/HF badge lost, lineage untouched`, async () => {
      const readNodes = () =>
        JSON.parse(readFileSync(sb.path(FEEDS_DIR, "code-links.json"), "utf8")).nodes as Record<
          string,
          unknown
        >;
      const beforeNodes = readNodes();
      const run = await runCli(
        sb,
        "lineage/theme/feed/themeFeedsCli.ts",
        [...args, "--what", "code-links"],
        {
          fixtures: ["theme-feeds-http"],
          faults: [{ match: "huggingface.co", ...fault }],
        },
      );
      expect(run.code, describeRun(run)).toBe(4);
      expect(run.requests.some((r) => r.outcome === "fault")).toBe(true);
      // The stale cached answers are kept: the page shows what it showed.
      expect(readNodes()).toEqual(beforeNodes);
      expect(snapshot(sb)[`${FEEDS_DIR}/lineage.json`]).toBe(lineageSha);
    });
  }
});
