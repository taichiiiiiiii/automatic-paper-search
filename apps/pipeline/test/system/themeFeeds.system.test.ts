/**
 * System test (c): the theme feeds CLI (R4-3) through the REAL entry point
 * against recorded OpenAlex / Hugging Face Papers answers.
 *
 * Fixtures: `fixtures/theme-feeds-http` — one polite live recording of
 * `--now 2026-10-12T00:00:00Z --days 200 --max-pages 2 --min-cites 1` for
 * the published flash-attention lineage (1 OpenAlex list page, 14 HF
 * lookups). One OpenAlex title is suffixed with "(FlashAttention)" so the
 * term-only topic gate keeps exactly one paper; everything else is
 * verbatim (fixtures/README.md).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { validateArtifact } from "@paperpilot/core/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliRun, describeRun, runCli } from "./support/runCli.js";
import type { Sandbox } from "./support/sandbox.js";
import { FEEDS_ARGS, FEEDS_DIR, feedsSandbox } from "./support/scenarios.js";

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("theme feeds: new papers + code links from recorded OpenAlex / HF", () => {
  let sb: Sandbox;
  let first: CliRun;
  let second: CliRun;
  let lineageSha: string;
  const out: Record<string, string> = {};

  beforeAll(async () => {
    sb = feedsSandbox();
    lineageSha = sha(sb.path(FEEDS_DIR, "lineage.json"));
    first = await runCli(sb, "lineage/theme/feed/themeFeedsCli.ts", FEEDS_ARGS, {
      fixtures: ["theme-feeds-http"],
    });
    for (const f of ["new-papers.json", "feed.xml", "code-links.json"]) {
      out[f] = readFileSync(sb.path(FEEDS_DIR, f), "utf8");
    }
    second = await runCli(sb, "lineage/theme/feed/themeFeedsCli.ts", FEEDS_ARGS, {
      fixtures: ["theme-feeds-http"],
    });
  });
  afterAll(() => sb?.cleanup());

  it("exits 0, never touches lineage.json, and calls only OpenAlex and HF", () => {
    expect(first.code, describeRun(first)).toBe(0);
    expect(first.requests.filter((r) => r.outcome !== "fixture")).toEqual([]);
    const hosts = new Set(first.requests.map((r) => new URL(r.url).host));
    expect([...hosts].sort()).toEqual(["api.openalex.org", "huggingface.co"]);
    expect(first.requests.filter((r) => r.url.includes("openalex"))).toHaveLength(1);
    expect(sha(sb.path(FEEDS_DIR, "lineage.json"))).toBe(lineageSha);
  });

  it("writes schema-valid new-papers / Atom feed with the kept conference paper", () => {
    const doc = JSON.parse(out["new-papers.json"] as string);
    const v = validateArtifact("theme-new-papers-v1", doc);
    expect(v.errors ?? []).toEqual([]);
    expect(doc.stats).toMatchObject({ fetched: 49, excluded_type: 0, kept: 1 });
    expect(doc.items).toHaveLength(1);
    const item = doc.items[0];
    expect(item).toMatchObject({ id: "openalex:W7166307650", type: "conference-paper" });
    const lineage = JSON.parse(readFileSync(sb.path(FEEDS_DIR, "lineage.json"), "utf8"));
    const nodeIds = new Set(lineage.nodes.map((n: { id: string }) => n.id));
    for (const id of item.cites_lineage) expect(nodeIds.has(id)).toBe(true);
    const atom = out["feed.xml"] as string;
    expect(atom).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(atom.match(/<entry>/g)).toHaveLength(1);
    expect(atom).toContain("https://openalex.org/W7166307650");
    expect(atom).toContain("OpenAlex (CC0)");
  });

  it("writes schema-valid code links from HF answers only", () => {
    const doc = JSON.parse(out["code-links.json"] as string);
    const v = validateArtifact("theme-code-links-v1", doc);
    expect(v.errors ?? []).toEqual([]);
    const nodes = Object.values(doc.nodes) as { hf: { url: string } | null }[];
    const hf = nodes.filter((n) => n.hf !== null);
    expect(hf).toHaveLength(7);
    for (const n of hf)
      expect(n.hf?.url).toMatch(/^https:\/\/huggingface\.co\/papers\/\d{4}\.\d{4,5}$/);
    expect(existsSync(sb.path("data/state/hf-papers/papers.json"))).toBe(true);
  });

  it("a second run re-uses the fresh HF cache and is byte-stable", () => {
    expect(second.code, describeRun(second)).toBe(0);
    expect(second.requests.filter((r) => r.url.includes("huggingface"))).toEqual([]);
    for (const f of ["new-papers.json", "feed.xml", "code-links.json"]) {
      expect(readFileSync(sb.path(FEEDS_DIR, f), "utf8"), f).toBe(out[f]);
    }
  });
});
