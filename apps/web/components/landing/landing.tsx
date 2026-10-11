"use client";

/**
 * S0 search-first landing page (port of docs/index.html + the parts of
 * docs/assets/landing.js listed in this agent's brief: conference/paper
 * counts with the 複数/多数 fallback, the collapsible conference list,
 * example chips, pointer-gated initial focus, and the audited-lineage
 * shelf). The search box itself, its facets, full results, and the
 * detail dialog are owned by components/search/* (ported from
 * docs/assets/search.js / search-detail.js) and mounted here unchanged.
 *
 * The audited-lineage shelf (`#s0-lineages`, SCR-11,
 * docs/migration/safety-contracts.md) fetches `lineage-quality-v1.json`
 * and opens only for rows `lib/landing-lineage.ts` (which imports, not
 * re-ports, `lib/lineage/core.ts`'s `qualityRowIsEligible`) says are
 * eligible. Every other outcome -- the initial unresolved state, a
 * resolved-but-empty manifest, or any fetch/parse failure -- renders
 * the exact same truthful "closed" copy index.html ships statically,
 * so a visitor never sees a false "nothing published" vs. a false
 * "something published" state (fail closed).
 */
import { useEffect, useRef, useState } from "react";
import type { ConferenceSummary, DataResult } from "../../lib/data";
import { fetchConferences } from "../../lib/data";
import { fetchLineageQualityManifest } from "../../lib/data-lineage";
import {
  conferenceHref,
  deriveLandingConferenceState,
  PLACEHOLDER_COUNTS,
  UNKNOWN_COUNTS,
  venueLabel,
} from "../../lib/landing";
import {
  lineageShelfEmptyText,
  lineageShelfHref,
  lineageShelfLede,
  lineageShelfMeta,
  lineageShelfStaleNote,
  lineageShelfStatus,
  lineageShelfTier,
  selectLineageShelfRows,
} from "../../lib/landing-lineage";
import type { QualityRow } from "../../lib/lineage/core";
import { PublicationBadge } from "../lineage/publication-badge";
import { SearchArea, type SearchAreaHandle } from "../search/search-area";
import { SearchDetailDialog } from "../search/search-detail-dialog";
import styles from "./landing.module.css";

// "loading" is the pre-hydration / in-flight state. It used to be "closed",
// so the static HTML (what crawlers, no-JS readers and the first paint
// see) claimed "公開条件を満たす系譜は現在ありません" even while themes
// were published (design doc 48 P0-4). "closed" now means the manifest
// really resolved with no eligible row.
type LineageShelfState =
  | { kind: "loading" }
  | { kind: "closed" }
  | { kind: "failed" }
  | { kind: "open"; rows: QualityRow[] };

const EXAMPLE_CHIPS = ["diffusion", "3d gaussian", "reasoning"] as const;

export function Landing() {
  const [counts, setCounts] = useState(PLACEHOLDER_COUNTS);
  const [confList, setConfList] = useState<Array<{ name: string; papers: number }>>([]);
  const [confLabel, setConfLabel] = useState("学会から探す");
  const [confsExpanded, setConfsExpanded] = useState(false);
  const [lineageShelf, setLineageShelf] = useState<LineageShelfState>({ kind: "loading" });

  const searchAreaRef = useRef<SearchAreaHandle>(null);

  useEffect(() => {
    let cancelled = false;
    fetchConferences().then((result: DataResult<ConferenceSummary[]>) => {
      if (cancelled) return;
      if (result.status === "error") {
        setCounts(UNKNOWN_COUNTS);
        return;
      }
      const state = deriveLandingConferenceState(result.data);
      if (state.kind === "unknown") {
        setCounts(UNKNOWN_COUNTS);
        return;
      }
      setCounts({ n: state.n, m: state.m });
      setConfList(state.list);
      setConfLabel(state.label);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches) {
      searchAreaRef.current?.focusInput();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchLineageQualityManifest().then((result) => {
      if (cancelled) return;
      if (result.status === "error") {
        setLineageShelf({ kind: "failed" });
        return;
      }
      const rows = selectLineageShelfRows(result.data);
      setLineageShelf(rows.length > 0 ? { kind: "open", rows } : { kind: "closed" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main id="main-content" className={styles.s0}>
      <h1 className="visually-hidden">PaperPilot AI 論文検索</h1>

      <p className={styles.lede} id="s0-lede">
        <em className={styles.ledeEm}>AI トップ会議</em>{" "}
        <span className={styles.ledeN} id="s0-n">
          {counts.n}
        </span>{" "}
        学会・
        <span className={styles.ledeN} id="s0-m">
          {counts.m}
        </span>{" "}
        本から探す。
        <span id="s0-lineage-note">{lineageShelfLede(lineageShelf.kind)}</span>
      </p>

      <SearchArea handleRef={searchAreaRef} />

      <fieldset className={styles.examples} aria-label="検索の例">
        <span className={styles.examplesLabel}>例:</span>
        {EXAMPLE_CHIPS.map((query) => (
          <button
            key={query}
            type="button"
            className={styles.chip}
            data-query={query}
            onClick={() => searchAreaRef.current?.applyExampleQuery(query)}
          >
            {query}
          </button>
        ))}
      </fieldset>

      <details className={styles.nextSteps}>
        <summary>検索した後は？</summary>
        <ol>
          <li>検索結果のタイトルを選び、学会カタログで論文の詳細を確認します。</li>
          <li>家系図は、その論文の詳細から、公開済みの場合だけ開けます。</li>
          <li>
            テーマ別の系譜は、自動検査に合格したものを公開しています。人がまだ確認していないものは「未監査」と表示します。
          </li>
        </ol>
      </details>

      <section className={styles.confs} id="s0-confs">
        <button
          type="button"
          className={styles.confsToggle}
          id="s0-confs-toggle"
          aria-expanded={confsExpanded}
          aria-controls="s0-confs-list"
          onClick={() => setConfsExpanded((expanded) => !expanded)}
        >
          <span className={styles.confsCaret} aria-hidden="true">
            {confsExpanded ? "▾" : "▸"}
          </span>
          <span id="s0-confs-label">{confLabel}</span>
        </button>
        <ul
          className={styles.confsList}
          id="s0-confs-list"
          aria-labelledby="s0-confs-label"
          hidden={!confsExpanded}
        >
          {confList.map((conference) => (
            <li key={conference.name} className={styles.conf}>
              <a className={styles.confLink} href={conferenceHref(conference.name)}>
                {venueLabel(conference.name)}
              </a>
              <span className={styles.confCount}>
                {conference.papers}
                <span className="visually-hidden"> 本</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Audited-lineage shelf (SCR-11): fail-closed on any fetch/parse
          failure or on a resolved-but-empty manifest -- see this file's
          header comment. */}
      <section className={styles.lineages} id="s0-lineages" aria-labelledby="s0-lineages-heading">
        <h2 className={styles.lineagesHeading} id="s0-lineages-heading">
          系譜の公開状況
        </h2>
        <p className="visually-hidden" id="s0-lineages-status" role="status">
          {lineageShelf.kind === "open"
            ? `${lineageShelf.rows.length} 件の系譜を表示しています。`
            : lineageShelfStatus(lineageShelf.kind)}
        </p>
        <ul className={styles.lineagesList} id="s0-lineages-list">
          {lineageShelf.kind === "open" ? (
            lineageShelf.rows.map((row) => {
              const stale = lineageShelfStaleNote(row);
              const tier = lineageShelfTier(row);
              return (
                <li key={row.collection_id} className={styles.lineageItem}>
                  <a className={styles.lineageLink} href={lineageShelfHref(row)}>
                    {row.label}
                  </a>
                  {tier !== null ? <PublicationBadge tier={tier} /> : null}
                  <span className={styles.lineageMeta}>{lineageShelfMeta(row)}</span>
                  {stale !== null ? <span className={styles.lineageStale}>{stale}</span> : null}
                </li>
              );
            })
          ) : (
            <li className={styles.lineageEmpty}>{lineageShelfEmptyText(lineageShelf.kind)}</li>
          )}
        </ul>
      </section>

      <SearchDetailDialog />
    </main>
  );
}
