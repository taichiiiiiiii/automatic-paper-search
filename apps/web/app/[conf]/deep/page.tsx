"use client";

import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AuditStatus } from "../../../components/lineage/audit-status";
import { RelationList } from "../../../components/lineage/relation-list";
import {
  fetchDeepManifestBytes,
  fetchLineageArtifactBytes,
  fetchLineageQualityManifest,
} from "../../../lib/data-lineage";
import { conferenceDisplayName } from "../../../lib/lineage/conference-name";
import {
  type DeepManifest,
  type LineageArtifact,
  parseArtifact,
  parseDeepManifest,
  type QualityRow,
  qualityRowIsEligible,
  qualityRowIsPublishable,
  type Relation,
  resolveManifestEntry,
} from "../../../lib/lineage/core";
import {
  type DeepPrefsStore,
  deepDisplayUrl,
  loadDeepRelations,
  saveDeepRelations,
} from "../../../lib/lineage/deep-prefs";
import { DEFAULT_VISIBLE_RELATIONS } from "../../../lib/lineage/relations";

/**
 * Ported from docs/<conf>/deep.html + docs/assets/deep.js `init`.
 *
 * The deep gate is per-paper (each focus paper is its own quality row,
 * `deep:<conf>:<paperId>`), bound to BOTH that paper's artifact hash
 * AND the manifest's hash (SCR-27/SCR-28: a paper cannot become
 * selectable just because the manifest changed, nor can the manifest
 * grant access to an artifact whose own hash does not match). The
 * picker therefore only ever lists manifest entries whose quality row
 * is eligible under the manifest hash actually fetched -- never from a
 * raw `?paper=`/`?arxiv=` URL parameter (SCR-28).
 *
 * Parity gap: same as app/[conf]/lineage/page.tsx (list view only, no
 * SVG tree/timeline). All 14 deep rows in the published manifest are
 * ineligible today, so this picker path is unexercised against real
 * data -- see the final report. Unlike `/[conf]/lineage/`, there is no
 * graph view here to share a relation filter with, so this page keeps
 * its own `visibleRelations` state -- but it persists it the way
 * deep.js does (`localStorage["pp.deep.prefs"]` + `?relations=`), via
 * lib/lineage/deep-prefs.ts rather than the lineage viewer's own
 * `pp.lineage.prefs`, so the two pages never overwrite each other's
 * filter.
 */
type GateState =
  | { phase: "loading" }
  | { phase: "pending" }
  | {
      phase: "ready";
      manifest: DeepManifest;
      manifestSha256: string;
      eligibleRows: QualityRow[];
    };

/** deep.js reads `pp.deep.prefs` at module load; the equivalent here is
 * a lazy `useState` initializer, which also runs during the static
 * export, so the store is handed over as a thunk and only resolved in
 * the browser. lib/lineage/deep-prefs.ts wraps the whole access in
 * try/catch -- Safari throws when the `window.localStorage` *getter*
 * itself is read with cookies blocked, not only on get/set. */
function deepPrefsStore(): DeepPrefsStore | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

/** Server renders the defaults, client restores the visitor's own
 * filter. Safe to differ: `RelationList` (the only consumer) is mounted
 * once `state.phase === "ready"`, which never happens in the exported
 * HTML or in the first client render -- both show the audit-pending
 * gate -- so no hydrated markup depends on this value. */
function initialVisibleRelations(): Set<Relation> {
  if (typeof window === "undefined") return new Set(DEFAULT_VISIBLE_RELATIONS);
  return loadDeepRelations(window.location.search, deepPrefsStore);
}

// Shared loading copy with app/lineage/page.tsx's Focus View and
// app/[conf]/lineage/page.tsx (same "verifying the index matches the
// audit" wait state) -- pinned by test/lineage/routes.test.ts across
// all gated lineage/deep routes, so the pre-hydration static HTML says
// the same thing everywhere while the client-side quality-manifest
// fetch is still in flight.
const LOADING_HEADING = "研究系譜を検証しています";
const LOADING_MESSAGE = "公開索引と監査情報の一致を確認しています。";

export default function ConferenceDeepPage() {
  const params = useParams<{ conf: string }>();
  const slug = params.conf;
  const display = conferenceDisplayName(slug);
  const [state, setState] = useState<GateState>({ phase: "loading" });
  const [visibleRelations, setVisibleRelations] =
    useState<ReadonlySet<Relation>>(initialVisibleRelations);
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<LineageArtifact | null>(null);
  const [artifactError, setArtifactError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const quality = await fetchLineageQualityManifest();
      if (cancelled) return;
      if (quality.status === "error") {
        setState({ phase: "pending" });
        return;
      }
      const manifestBytes = await fetchDeepManifestBytes(slug);
      if (cancelled) return;
      if (manifestBytes.status === "error") {
        setState({ phase: "pending" });
        return;
      }
      const manifest = parseDeepManifest(manifestBytes.data.raw);
      if (!manifest) {
        setState({ phase: "pending" });
        return;
      }
      const manifestSha256 = manifestBytes.data.sha256;
      const deepRows = quality.data.collections.filter(
        (row) => row.kind === "deep" && row.conference === slug,
      );
      const eligibleRows = deepRows.filter((row) => qualityRowIsEligible(row, { manifestSha256 }));
      if (eligibleRows.length === 0) {
        setState({ phase: "pending" });
        return;
      }
      setState({ phase: "ready", manifest, manifestSha256, eligibleRows });
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const eligibleEntries = useMemo(() => {
    if (state.phase !== "ready") return [];
    return state.eligibleRows
      .map((row) => ({
        row,
        entry: resolveManifestEntry(state.manifest, { paper: row.paper_id ?? null }),
      }))
      .filter(
        (
          pair,
        ): pair is {
          row: QualityRow;
          entry: NonNullable<ReturnType<typeof resolveManifestEntry>>;
        } => pair.entry !== null,
      );
  }, [state]);

  useEffect(() => {
    if (state.phase !== "ready" || eligibleEntries.length === 0) return;
    if (selectedPaperId === null) {
      setSelectedPaperId(eligibleEntries[0]?.row.paper_id ?? null);
    }
  }, [state, eligibleEntries, selectedPaperId]);

  useEffect(() => {
    if (state.phase !== "ready" || selectedPaperId === null) return;
    const pair = eligibleEntries.find((p) => p.row.paper_id === selectedPaperId);
    if (!pair) return;
    // Captured as plain consts (not accessed via `pair`/`state` inside the
    // nested `run()`) because TS does not retain narrowing of a possibly
    // `undefined`/union value across a function-declaration closure.
    const row = pair.row;
    const manifestSha256 = state.manifestSha256;
    let cancelled = false;
    setArtifactError(false);
    setArtifact(null);
    async function run() {
      const fetched = await fetchLineageArtifactBytes(row.path, row.input_sha256 ?? "");
      if (cancelled) return;
      if (fetched.status === "error") {
        setArtifactError(true);
        return;
      }
      if (!qualityRowIsPublishable(row, { artifactSha256: fetched.data.sha256, manifestSha256 })) {
        setArtifactError(true);
        return;
      }
      const parsed = parseArtifact(fetched.data.raw, { kind: "deep" });
      if (!parsed) {
        setArtifactError(true);
        return;
      }
      setArtifact(parsed);
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [state, selectedPaperId, eligibleEntries]);

  // Ported from deep.js `renderFilterChips`'s click handler: toggle the
  // relation, then `savePrefs()` + `syncDisplayUrl()`. Unlike
  // lineage-graph-app's `persist`, no `?view=` is written -- this port
  // has no list/graph toggle yet.
  function toggleRelation(relation: Relation): void {
    const next = new Set(visibleRelations);
    if (next.has(relation)) next.delete(relation);
    else next.add(relation);
    setVisibleRelations(next);
    saveDeepRelations(next, deepPrefsStore);
    window.history.replaceState({}, "", deepDisplayUrl(window.location.href, next));
  }

  return (
    <main id="main-content" className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2 border-b border-rule pb-6">
        <nav aria-label="breadcrumb" className="text-xs text-ink-subtle">
          <a href="/" className="hover:text-accent">
            PaperPilot
          </a>{" "}
          /{" "}
          <a href={`/${slug}/`} className="hover:text-accent">
            {display}
          </a>{" "}
          / Deep Lineage
        </nav>
        <h1 className="font-serif text-2xl font-bold text-ink">
          <em>Deep Lineage</em> — {state.phase === "ready" ? display : `${display} 監査待ち`}
        </h1>
        <p className="text-sm text-ink-muted">
          {state.phase === "ready"
            ? "品質監査に合格した論文間の関係を表示しています。"
            : `${display} の深掘り系譜データは品質監査中です。合格するまで内容は公開しません。`}
        </p>
        <p className="text-xs text-ink-subtle">
          構造・識別子・関係根拠と入力ハッシュの検証が完了するまで、未監査データは読み込みません。
        </p>
      </header>

      {state.phase !== "ready" && (
        <AuditStatus
          heading={state.phase === "loading" ? LOADING_HEADING : "公開監査を待っています"}
          message={
            state.phase === "loading"
              ? LOADING_MESSAGE
              : "構造・識別子・関係根拠の検査が完了するまで、論文選択・検索・表示切替・グラフを利用できません。"
          }
          backHref={`/${slug}/`}
          backLabel={`${display} の論文カタログへ戻る`}
        />
      )}

      {state.phase === "ready" && (
        <article className="flex flex-col gap-6">
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-ink">焦点論文:</span>
            <select
              aria-label="Select focus paper"
              value={selectedPaperId ?? ""}
              onChange={(e) => setSelectedPaperId(e.target.value)}
              className="rounded border border-rule bg-paper px-2 py-1 text-sm text-ink"
            >
              {eligibleEntries.map((pair) => (
                <option key={pair.row.paper_id} value={pair.row.paper_id ?? ""}>
                  {pair.entry.title}
                </option>
              ))}
            </select>
          </label>
          {artifactError && (
            <p role="alert" className="text-sm text-accent-strong">
              この論文の深掘り系譜を検証できませんでした。
            </p>
          )}
          {artifact && (
            <RelationList
              artifact={artifact}
              focusId={artifact.root}
              visibleRelations={visibleRelations}
              onToggleRelation={toggleRelation}
            />
          )}
        </article>
      )}
    </main>
  );
}
