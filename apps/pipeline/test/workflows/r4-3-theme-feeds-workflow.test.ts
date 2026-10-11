/**
 * R4-3 (design 48 P1-1 / P1-2): theme-feeds.yml contract — dispatch only
 * (no `schedule:`; the Worker cron dispatches it once enabled), develop
 * only, embedding caches restored before the CLI (gate kept on), the
 * OpenAlex key passed, a run credit cap, and the commit limited to the
 * side files (never lineage.json, whose sha256 the audit binds).
 */
import { describe, expect, it } from "vitest";
import { TOPIC_EMBEDDING_MODEL } from "../../src/lineage/theme/topicEmbedding.js";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

const doc = readWorkflow("theme-feeds.yml");
const job = jobsOf(doc).find(([id]) => id === "feeds")![1] as YamlDoc;
const steps = job.steps as YamlDoc[];
const find = (pred: (s: YamlDoc) => boolean) => steps.findIndex(pred);

describe("theme-feeds.yml (R4-3)", () => {
  it("releases the pushed commit itself (a GITHUB_TOKEN push does not trigger pages.yml)", () => {
    const release = jobsOf(doc).find(([id]) => id === "release")?.[1] as YamlDoc | undefined;
    expect(release).toBeDefined();
    expect(release!.uses).toBe("./.github/workflows/pages-release.yml");
    expect(release!.secrets).toBe("inherit");
    expect(release!.needs).toBe("feeds");
    expect(release!.if).toBe("needs.feeds.outputs.changed == 'true'");
    expect(release!.with.source_sha).toBe("${{ needs.feeds.outputs.source_sha }}");
    expect(release!.with.release_kind).toBe("normal");
    expect(job.outputs.changed).toBe("${{ steps.commit.outputs.changed }}");
  });

  it("is dispatch-only and runs on develop", () => {
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    expect(job.if).toBe("github.ref == 'refs/heads/develop'");
    expect(doc.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "write" });
  });

  it("restores the topic-embedding caches before the CLI and keeps the gate on", () => {
    const model = find((s) => s.name === "Restore topic-embedding model");
    const vectors = find((s) => s.name === "Restore topic-embedding vectors");
    const cli = find((s) => typeof s.run === "string" && s.run.includes("themeFeedsCli.ts"));
    expect(steps[model]!.with.key).toContain(TOPIC_EMBEDDING_MODEL.revision);
    expect(model).toBeLessThan(vectors);
    expect(vectors).toBeLessThan(cli);
    expect(steps[cli]!.run).not.toContain("--no-topic-embedding");
    expect(steps[cli]!.run).toContain("--max-credits");
    expect(steps[cli]!.env.PAPERPILOT_OPENALEX_API_KEY).toBe(
      "${{ secrets.PAPERPILOT_OPENALEX_API_KEY }}",
    );
  });

  it("commits only the side files", () => {
    const commit = steps[find((s) => s.name === "Commit feeds to develop")]!;
    expect(commit.run).toContain("release/cli.ts commit-push");
    expect(commit.run).not.toContain("lineage.json");
    for (const f of ["new-papers.json", "feed.xml", "code-links.json", "hf-papers/papers.json"]) {
      expect(commit.run).toContain(f);
    }
  });
});
