/**
 * Citation signal via Semantic Scholar `/paper/batch` — TS port of
 * `paperpilot/signals/citation_signal.py` (COL-28 of
 * docs/migration/safety-contracts.md).
 *
 * A single batch request resolves up to 500 papers, identified by
 * `ARXIV:<id>` or `DOI:<doi>`; papers without either are skipped.
 *
 * Normalization (CLAUDE.md "スコアリング" table):
 *   citation_velocity = citations / days_since_publication
 *   citation_score    = min(velocity / SATURATION, 1) * 100
 */

import type { FetchLike } from "../http/requestWithRetry.js";
import { requestWithRetry } from "../http/requestWithRetry.js";
import type { Paper } from "../model/paper.js";
import { pyStrptimeYMD, toLocalIsoDate } from "../pyish.js";
import { BaseSignal } from "./signal.js";

const S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch";
const BATCH_SIZE = 500;
const FIELDS =
  "paperId,title,citationCount,influentialCitationCount," +
  "publicationDate,year,authors.authorId,authors.name,venue";

export interface CitationSignalConfig {
  enabled?: boolean;
  velocity_saturation?: number;
}

export interface CitationSignalDeps {
  fetchImpl: FetchLike;
  apiKey?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Clock for "today" in the velocity calculation — injected for determinism. */
  today?: () => Date;
  logger?: { warn: (msg: string) => void };
}

interface CitationBatchPayload {
  paperId?: unknown;
  citationCount?: unknown;
  influentialCitationCount?: unknown;
  publicationDate?: unknown;
  year?: unknown;
  authors?: unknown;
  venue?: unknown;
}

export class CitationSignal extends BaseSignal {
  readonly name = "citation";
  private readonly saturation: number;
  private readonly apiKey: string | null;
  private readonly deps: CitationSignalDeps;

  constructor(config: CitationSignalConfig = {}, deps: CitationSignalDeps) {
    super(config);
    this.saturation = config.velocity_saturation ?? 2.0;
    this.apiKey = deps.apiKey ?? null;
    this.deps = deps;
  }

  enrichOne(paper: Paper): Paper {
    // enrich_batch is always what the runner calls; this satisfies the
    // Signal interface's synchronous enrichOne contract minimally (no real
    // call site in this port invokes it directly, mirroring the Python
    // `enrich_one` fallback's own note that it is "rarely used").
    return paper;
  }

  async enrichBatch(papers: Paper[]): Promise<Paper[]> {
    this.resetRunFailures();
    const indexed: [Paper, string][] = [];
    for (const p of papers) {
      const reqId = CitationSignal.requestId(p);
      if (reqId) indexed.push([p, reqId]);
    }
    if (indexed.length === 0) return papers;

    const today = this.deps.today ? this.deps.today() : new Date();
    for (let start = 0; start < indexed.length; start += BATCH_SIZE) {
      const chunk = indexed.slice(start, start + BATCH_SIZE);
      const ids = chunk.map(([, rid]) => rid);
      const data = await this.postBatch(ids);
      if (data === null) continue;
      if (data.length < chunk.length) {
        this.runFailures.push(`batch answered ${data.length} of ${chunk.length} ids`);
      }
      for (let i = 0; i < chunk.length; i++) {
        const payload = data[i];
        if (!payload) continue;
        const [paper] = chunk[i] as [Paper, string];
        this.apply(paper, payload, today);
      }
    }
    return papers;
  }

  private static requestId(p: Paper): string | null {
    if (p.arxivId) return `ARXIV:${p.arxivId}`;
    if (p.doi) return `DOI:${p.doi}`;
    return null;
  }

  private async postBatch(ids: string[]): Promise<(CitationBatchPayload | null)[] | null> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const resp = await requestWithRetry(
      {
        method: "POST",
        url: S2_BATCH_URL,
        params: { fields: FIELDS },
        headers,
        jsonBody: { ids },
        timeoutMs: 15000,
      },
      this.deps,
    );
    if (resp?.status !== 200) {
      const status = resp ? String(resp.status) : "None";
      this.deps.logger?.warn(`citation: batch failed (status=${status}, n=${ids.length})`);
      this.runFailures.push(`/paper/batch failed (status=${status}, n=${ids.length})`);
      return null;
    }
    const body: unknown = await resp.json();
    if (!Array.isArray(body)) {
      const typeName = body === null ? "NoneType" : typeof body;
      this.deps.logger?.warn(`citation: unexpected response shape: ${typeName}`);
      this.runFailures.push(
        `/paper/batch returned ${typeName} instead of a list (n=${ids.length})`,
      );
      return null;
    }
    return body as (CitationBatchPayload | null)[];
  }

  private apply(paper: Paper, payload: CitationBatchPayload, today: Date): void {
    const cites = typeof payload.citationCount === "number" ? payload.citationCount : 0;
    const infl =
      typeof payload.influentialCitationCount === "number" ? payload.influentialCitationCount : 0;
    paper.citationCount = cites;
    paper.influentialCitations = infl;

    paper.citationVelocity = CitationSignal.velocity(cites, payload, paper, today);
    if (this.saturation > 0) {
      paper.citationScore = Math.min(paper.citationVelocity / this.saturation, 1.0) * 100.0;
    }

    if (!paper.venue && typeof payload.venue === "string" && payload.venue) {
      paper.venue = payload.venue;
    }

    const authors = Array.isArray(payload.authors) ? payload.authors : [];
    if (authors.length > 0 && !paper.firstAuthorId) {
      const first = authors[0] as { authorId?: unknown } | null | undefined;
      if (first && typeof first.authorId === "string" && first.authorId) {
        paper.firstAuthorId = first.authorId;
      }
    }
  }

  private static velocity(
    cites: number,
    payload: CitationBatchPayload,
    paper: Paper,
    today: Date,
  ): number {
    if (cites <= 0) return 0.0;
    // Python: `datetime.strptime(pub_str, "%Y-%m-%d")`, which raises
    // ValueError (falling back to `paper.published_date`) on a string that
    // merely LOOKS like YYYY-MM-DD but is not a real calendar date (e.g.
    // S2 occasionally returning "2026-13-45"). The old shape-only regex
    // check here accepted such garbage, and `Date.parse` on it is NaN —
    // propagating through `daysBetween`/`Math.max` to a NaN `citationScore`
    // (collect LOW: malformed S2 publicationDate -> NaN score).
    let pub =
      (typeof payload.publicationDate === "string"
        ? pyStrptimeYMD(payload.publicationDate)
        : null) ?? paper.publishedDate;
    const todayStr = toLocalIsoDate(today);
    // S2 occasionally returns a publicationDate in the future (embargo /
    // timezone glitch). Clamp so velocity never gets artificially inflated
    // by a negative elapsed-days fallthrough.
    if (pub > todayStr) pub = todayStr;
    const days = Math.max(daysBetween(pub, todayStr), 1);
    return cites / days;
  }
}

function daysBetween(isoA: string, isoB: string): number {
  const a = Date.parse(`${isoA}T00:00:00Z`);
  const b = Date.parse(`${isoB}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
