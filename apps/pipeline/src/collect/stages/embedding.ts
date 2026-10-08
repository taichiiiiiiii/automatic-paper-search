/**
 * Stage 3: embedding similarity against a research profile — TS port of
 * `paperpilot/pipeline/stage_embedding.py` (COL-31 of
 * docs/migration/safety-contracts.md).
 *
 * `AbstractEncoder` is a pluggable interface; no real backend (MiniLM /
 * SPECTER2 / etc) is implemented here — that is P4d. This port covers the
 * stage's own orchestration (profile-empty pass-through, cosine
 * similarity math, encoder-failure fall-through) against a fake encoder,
 * exactly as `test_stage_embedding.py` does.
 *
 * Normalization: cos-sim in [-1, 1] -> `(sim + 1) / 2 * 100`, clipped to
 * [0, 100].
 */

import type { Paper } from "../model/paper.js";

export interface AbstractEncoder {
  /** Returns one embedding vector per input text, same length/order as `texts`. */
  encode(texts: readonly string[]): number[][] | Promise<number[][]>;
}

export interface EmbedAndRankParams {
  encoder: AbstractEncoder;
  profileText: string;
  topN: number;
  weight: number;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

function paperText(p: Paper): string {
  const abstractSnippet = (p.abstract ?? "").slice(0, 400);
  return `${p.title}. ${abstractSnippet}`;
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

function norm(v: readonly number[]): number {
  return Math.sqrt(dot(v, v));
}

function cosineSimilarity(vectors: readonly number[][], query: readonly number[]): number[] {
  const qNorm = norm(query);
  return vectors.map((v) => {
    const denom = norm(v) * qNorm;
    return denom === 0 ? 0 : dot(v, query) / denom;
  });
}

/**
 * Computes cos-sim between each paper and the profile, adding it to
 * `totalScore`. Fail-Safe: if the encoder throws, papers flow through
 * unchanged with `embeddingSimilarity: null` so Stage 4 still has
 * something to rank.
 */
export async function embedAndRank(papers: Paper[], params: EmbedAndRankParams): Promise<Paper[]> {
  if (papers.length === 0) return [];

  // Mode A: no profile -> skip Stage 3 entirely.
  if (!params.profileText.trim()) {
    params.logger?.info("stage3: profile empty, skipping embedding step");
    return params.topN > 0 ? papers.slice(0, params.topN) : papers;
  }

  let vectors: number[][];
  let profileVec: number[];
  try {
    const paperTexts = papers.map(paperText);
    vectors = await params.encoder.encode(paperTexts);
    const [pv] = await params.encoder.encode([params.profileText]);
    profileVec = pv as number[];
  } catch (e) {
    params.logger?.warn(`stage3: encoder failed (${(e as Error).message}); skipping embedding`);
    return params.topN > 0 ? papers.slice(0, params.topN) : papers;
  }

  const sims = cosineSimilarity(vectors, profileVec);
  for (let i = 0; i < papers.length; i++) {
    const score = Math.min(Math.max((((sims[i] as number) + 1.0) / 2.0) * 100.0, 0.0), 100.0);
    const paper = papers[i] as Paper;
    paper.embeddingSimilarity = score;
    paper.totalScore = paper.totalScore + score * params.weight;
  }

  const sorted = [...papers].sort((a, b) => b.totalScore - a.totalScore);
  const out = params.topN > 0 ? sorted.slice(0, params.topN) : sorted;
  params.logger?.info(`stage3: kept top ${out.length} papers after embedding rerank`);
  return out;
}
