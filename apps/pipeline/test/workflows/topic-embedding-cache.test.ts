/**
 * R2-11 (design 41 D7) workflow contract: both theme generators restore
 * the topic-embedding model and vector caches (SHA-pinned actions/cache)
 * before the theme CLI runs, keyed by the model revision pinned in
 * `topicEmbedding.ts`, at the paths the CLI reads (git-ignored lineage
 * cache), and never pass a flag that disables the gate.
 */
import { describe, expect, it } from "vitest";
import { TOPIC_EMBEDDING_MODEL } from "../../src/lineage/theme/topicEmbedding.js";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

const MODEL_DIR = "data/state/lineage-cache/models";
const VECTOR_DIR = "data/state/lineage-cache/embeddings";

for (const file of ["regen-themes.yml", "theme-on-demand.yml"]) {
  describe(`${file} topic-embedding caches (R2-11)`, () => {
    const gen = jobsOf(readWorkflow(file)).find(([id]) => id === "generate")![1] as YamlDoc;
    const steps = gen.steps as YamlDoc[];
    const idx = (pred: (s: YamlDoc) => boolean) => steps.findIndex(pred);
    const model = steps[idx((s) => s.name === "Restore topic-embedding model")];
    const vectors = steps[idx((s) => s.name === "Restore topic-embedding vectors")];
    const cli = idx((s) => typeof s.run === "string" && s.run.includes("lineage/theme/cli.ts"));

    it("restores the model keyed by model + pinned revision", () => {
      expect(model.uses).toMatch(/^actions\/cache@[0-9a-f]{40}$/);
      expect(model.with.path).toBe(MODEL_DIR);
      expect(model.with.key).toContain(TOPIC_EMBEDDING_MODEL.revision);
      expect(model.with.key).toContain(TOPIC_EMBEDDING_MODEL.repo.replace("/", "-"));
    });

    it("rolls the vector cache forward per run, scoped to the revision", () => {
      expect(vectors.uses).toBe(model.uses);
      expect(vectors.with.path).toBe(VECTOR_DIR);
      const prefix = `topic-embedding-vectors-${TOPIC_EMBEDDING_MODEL.revision.slice(0, 12)}-`;
      expect(vectors.with.key.startsWith(prefix)).toBe(true);
      expect(vectors.with.key).toContain("${{ github.run_id }}");
      expect(vectors.with["restore-keys"].trim()).toBe(prefix);
    });

    it("runs both before the theme CLI, which keeps the embedding gate on", () => {
      expect(cli).toBeGreaterThan(steps.indexOf(vectors));
      expect(steps.indexOf(vectors)).toBeGreaterThan(steps.indexOf(model));
      expect(steps[cli].run).not.toContain("--no-topic-embedding");
      expect(steps[cli].run).not.toContain("--no-topic-gate");
    });
  });
}
