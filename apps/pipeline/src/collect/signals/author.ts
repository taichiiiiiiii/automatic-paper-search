/**
 * Author signal via Semantic Scholar `/author/batch` — TS port of
 * `paperpilot/signals/author_signal.py` (COL-29 of
 * docs/migration/safety-contracts.md).
 *
 * Reads `paper.firstAuthorId` (populated by {@link CitationSignal} or by
 * `S2Source`) and fetches h-index in batches of up to 1000 IDs.
 *
 * Normalization: `author_score = min(h_index / 50, 1) * 100`.
 */

import type { FetchLike } from "../http/requestWithRetry.js";
import { requestWithRetry } from "../http/requestWithRetry.js";
import type { Paper } from "../model/paper.js";
import { BaseSignal } from "./signal.js";

const S2_AUTHOR_BATCH_URL = "https://api.semanticscholar.org/graph/v1/author/batch";
const BATCH_SIZE = 1000;
// `authorId` is not decorative: enrichBatch keys its answer by
// `payload.authorId`, so a field list without it returns entries that
// cannot be matched back to a paper.
const FIELDS = "authorId,name,hIndex,citationCount";
const H_INDEX_SATURATION = 50.0;

export interface AuthorSignalDeps {
  fetchImpl: FetchLike;
  apiKey?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
}

interface AuthorBatchPayload {
  authorId?: unknown;
  hIndex?: unknown;
  name?: unknown;
}

export class AuthorSignal extends BaseSignal {
  readonly name = "author";
  private readonly apiKey: string | null;
  private readonly deps: AuthorSignalDeps;

  constructor(config: { enabled?: boolean } = {}, deps: AuthorSignalDeps) {
    super(config);
    this.apiKey = deps.apiKey ?? null;
    this.deps = deps;
  }

  enrichOne(paper: Paper): Paper {
    return paper;
  }

  async enrichBatch(papers: Paper[]): Promise<Paper[]> {
    this.resetRunFailures();
    const toFetch: [Paper, string][] = [];
    const seen = new Set<string>();
    const uniqueIds: string[] = [];
    for (const p of papers) {
      if (!p.firstAuthorId) continue;
      toFetch.push([p, p.firstAuthorId]);
      if (!seen.has(p.firstAuthorId)) {
        seen.add(p.firstAuthorId);
        uniqueIds.push(p.firstAuthorId);
      }
    }
    if (uniqueIds.length === 0) return papers;

    const hById = new Map<string, number>();
    for (let start = 0; start < uniqueIds.length; start += BATCH_SIZE) {
      const chunk = uniqueIds.slice(start, start + BATCH_SIZE);
      const data = await this.postBatch(chunk);
      if (data === null) continue;
      if (data.length < chunk.length) {
        this.runFailures.push(`batch answered ${data.length} of ${chunk.length} ids`);
      }
      let unmatched = 0;
      let missingHIndex = 0;
      for (const payload of data) {
        if (!payload) continue; // a null entry is a definitive "author not found"
        const aid = payload.authorId;
        if (!(typeof aid === "string" && aid.trim())) {
          unmatched += 1;
          continue;
        }
        if (!("hIndex" in payload)) {
          missingHIndex += 1;
          continue;
        }
        const h = typeof payload.hIndex === "number" ? payload.hIndex : 0;
        hById.set(aid, h);
      }
      if (unmatched) {
        this.runFailures.push(
          `batch returned ${unmatched} of ${chunk.length} entries without a usable authorId`,
        );
      }
      if (missingHIndex) {
        this.runFailures.push(
          `batch returned ${missingHIndex} of ${chunk.length} entries without a usable hIndex`,
        );
      }
    }

    for (const [paper, aid] of toFetch) {
      const h = hById.get(aid);
      if (h === undefined) continue;
      paper.authorHIndex = h;
      paper.authorScore = Math.min(h / H_INDEX_SATURATION, 1.0) * 100.0;
    }
    return papers;
  }

  private async postBatch(ids: string[]): Promise<(AuthorBatchPayload | null)[] | null> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const resp = await requestWithRetry(
      {
        method: "POST",
        url: S2_AUTHOR_BATCH_URL,
        params: { fields: FIELDS },
        headers,
        jsonBody: { ids },
        timeoutMs: 15000,
      },
      this.deps,
    );
    if (resp?.status !== 200) {
      const status = resp ? String(resp.status) : "None";
      this.deps.logger?.warn(`author: batch failed (status=${status}, n=${ids.length})`);
      this.runFailures.push(`/author/batch failed (status=${status}, n=${ids.length})`);
      return null;
    }
    const body: unknown = await resp.json();
    if (!Array.isArray(body)) {
      const typeName = body === null ? "NoneType" : typeof body;
      this.deps.logger?.warn(`author: unexpected response shape: ${typeName}`);
      this.runFailures.push(
        `/author/batch returned ${typeName} instead of a list (n=${ids.length})`,
      );
      return null;
    }
    return body as (AuthorBatchPayload | null)[];
  }
}
