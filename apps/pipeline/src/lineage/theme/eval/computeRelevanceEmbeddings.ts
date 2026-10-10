/**
 * R2-4 (design doc 42): text-embedding similarity scores for the
 * topic-relevance evaluation set. Research tool, NOT part of the
 * generator and NOT run in CI.
 *
 * `@huggingface/transformers` (onnxruntime, ~380 MB node_modules) is
 * deliberately not a repo dependency: install it in a scratch dir and
 * point `--transformers` at that prefix. Models are downloaded on first use into
 * `--model-cache` (all-MiniLM-L6-v2 q8 ≈ 23 MB, bge-small-en-v1.5 q8 ≈ 34 MB).
 *
 *   npm i --prefix /tmp/emb @huggingface/transformers@3
 *   pnpm exec tsx apps/pipeline/src/lineage/theme/eval/computeRelevanceEmbeddings.ts \
 *     --transformers /tmp/emb \
 *     --model-cache /tmp/emb/models \
 *     [--fixture apps/pipeline/test/lineage/theme/fixtures/relevance-eval-v1.json] \
 *     [--out apps/pipeline/test/lineage/theme/fixtures/relevance-eval-v1.scores.json]
 *
 * For every candidate and model it writes cosine similarities to:
 *  - `name`:     the theme name alone;
 *  - `terms`:    the theme name + its `theme_aliases.json` aliases/topic terms;
 *  - `seeds`:    the mean embedding of the theme's seeds (title+abstract);
 *  - `subject`:  the mean of the seeds whose TITLE is about the theme
 *                (`TopicScope.role === "subject"`; falls back to `seeds`);
 *  - `subject_terms`: mean of the `subject` centroid and the `terms` vector.
 * The scores file is committed so `evalRelevanceCli.ts` runs offline.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { aliasesFor, topicTermsFor } from "../seedFilters.js";
import { TopicScope } from "../topicScope.js";

export interface EvalCandidate {
  id: string;
  title: string;
  abstract: string;
  sources: string[];
  on_topic: boolean;
}

export interface EvalFixture {
  themes: Record<string, { theme: string; seeds: string[]; candidates: EvalCandidate[] }>;
}

const MODELS = [
  { name: "all-MiniLM-L6-v2", repo: "Xenova/all-MiniLM-L6-v2", queryPrefix: "" },
  {
    name: "bge-small-en-v1.5",
    repo: "Xenova/bge-small-en-v1.5",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
] as const;

function arg(argv: string[], flag: string, dflt?: string): string {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : dflt;
  if (v === undefined) throw new Error(`missing ${flag}`);
  return v;
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
function normalize(v: number[]): number[] {
  const n = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / n);
}
function mean(vs: number[][]): number[] {
  const out = new Array(vs[0]!.length).fill(0);
  for (const v of vs) {
    for (let i = 0; i < v.length; i++) out[i] += v[i]! / vs.length;
  }
  return normalize(out);
}

export function paperText(c: { title: string; abstract?: string }): string {
  return `${c.title}. ${(c.abstract ?? "").slice(0, 1500)}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fixturePath = arg(
    argv,
    "--fixture",
    "apps/pipeline/test/lineage/theme/fixtures/relevance-eval-v1.json",
  );
  const outPath = arg(argv, "--out", fixturePath.replace(/\.json$/, ".scores.json"));
  const tfPath = arg(argv, "--transformers");
  // `--transformers` = the npm prefix dir it was installed into.
  const entry = createRequire(join(tfPath, "noop.js")).resolve("@huggingface/transformers");
  const tf = (await import(pathToFileURL(entry).href)) as {
    pipeline: (
      task: string,
      model: string,
      opts: Record<string, unknown>,
    ) => Promise<
      (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>
    >;
    env: { cacheDir: string };
  };
  tf.env.cacheDir = arg(argv, "--model-cache");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as EvalFixture;
  const out: Record<string, unknown> = { schema: "relevance-eval-v1-scores", models: {} };
  for (const model of MODELS) {
    const t0 = Date.now();
    const embed = await tf.pipeline("feature-extraction", model.repo, { dtype: "q8" });
    const run = async (texts: string[]): Promise<number[][]> => {
      const vecs: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const r = await embed(texts.slice(i, i + 16), { pooling: "mean", normalize: true });
        vecs.push(...r.tolist());
      }
      return vecs;
    };
    const perTheme: Record<string, Record<string, Record<string, number>>> = {};
    let nTexts = 0;
    for (const [slug, t] of Object.entries(fixture.themes)) {
      const scope = TopicScope.forTheme(t.theme);
      const terms = [t.theme, ...aliasesFor(t.theme), ...topicTermsFor(t.theme)];
      const [nameVec, termsVec] = await run([
        `${model.queryPrefix}${t.theme}`,
        `${model.queryPrefix}${[...new Set(terms)].join("; ")}`,
      ]);
      const cands = t.candidates;
      const vecs = await run(cands.map(paperText));
      nTexts += cands.length + 2;
      const byId = new Map(cands.map((c, i) => [c.id, { c, v: vecs[i]! }]));
      const seedVecs = t.seeds.map((s) => byId.get(s)).filter((x) => x !== undefined);
      const subj = seedVecs.filter((x) => scope.role(x.c) === "subject");
      const seedsC = mean(seedVecs.map((x) => x.v));
      const subjC = subj.length > 0 ? mean(subj.map((x) => x.v)) : seedsC;
      const subjTerms = mean([subjC, termsVec!]);
      perTheme[slug] = {};
      for (const { c, v } of byId.values()) {
        const r = (x: number) => Math.round(x * 10000) / 10000;
        perTheme[slug][c.id] = {
          name: r(dot(v, nameVec!)),
          terms: r(dot(v, termsVec!)),
          seeds: r(dot(v, seedsC)),
          subject: r(dot(v, subjC)),
          subject_terms: r(dot(v, subjTerms)),
        };
      }
      process.stderr.write(
        `${model.name} ${slug}: ${seedVecs.length} seeds (${subj.length} subject)\n`,
      );
    }
    (out.models as Record<string, unknown>)[model.name] = {
      repo: model.repo,
      dtype: "q8",
      texts: nTexts,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      scores: perTheme,
    };
  }
  writeFileSync(outPath, `${JSON.stringify(out)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`${String(e)}\n`);
    process.exit(1);
  });
}
