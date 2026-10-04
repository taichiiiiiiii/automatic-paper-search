"use client";

import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AuditStatus } from "../../../components/lineage/audit-status";
import { DeepLineageApp, type DeepView } from "../../../components/lineage/graph/deep-lineage-app";
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
  resolveDeepFocusGate,
  resolveFocus,
  resolveManifestEntry,
  resolveView,
} from "../../../lib/lineage/core";
import {
  type DeepPrefsStore,
  deepDisplayUrl,
  loadDeepRelations,
  readDeepPrefs,
  readDeepViewPref,
  saveDeepPrefs,
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
 * is eligible under the manifest hash actually fetched. `?paper=`/
 * `?arxiv=` (ported via `lib/lineage/core.ts`'s `resolveDeepFocusGate`)
 * can select among THOSE already-eligible entries, same as the
 * picker's own `<select>` -- it is never used to build a path or grant
 * access to an otherwise-ineligible row, and an explicit request that
 * does not resolve fails closed (shows the same audit-pending look as
 * zero eligible rows) instead of silently falling back to the first
 * eligible entry (SCR-28).
 *
 * Now ports deep.js's graph/tree view, `?view=` list/graph switch,
 * search, scroll-to-focus and title updates too (via
 * components/lineage/graph/deep-lineage-app.tsx and
 * lib/lineage/layout/deep-{tree,view-model}.ts) -- previously this page
 * only rendered the list view. The one filter bar is shared between
 * both views (`visibleRelations`, persisted via
 * lib/lineage/deep-prefs.ts's `pp.deep.prefs` + `?relations=&view=`),
 * matching deep.js's single `#relation-filter` exactly (unlike
 * `/[conf]/lineage/`, which keeps two independent filter states, one
 * per view).
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

type ArtifactIssue = null | "verify-failed" | "root-mismatch";

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
 * filter. Safe to differ: the ready-state UI is mounted once
 * `state.phase === "ready"`, which never happens in the exported HTML
 * or in the first client render -- both show the audit-pending gate --
 * so no hydrated markup depends on this value. */
function initialVisibleRelations(): Set<Relation> {
  if (typeof window === "undefined") return new Set(DEFAULT_VISIBLE_RELATIONS);
  return loadDeepRelations(window.location.search, deepPrefsStore);
}

/** Ported from deep.js's initial `state.view` resolution
 * (`LineageCore.resolveView({urlView, savedView, matchMedia})`). */
function initialView(): DeepView {
  if (typeof window === "undefined") return "graph";
  const prefs = readDeepPrefs(deepPrefsStore);
  return resolveView({
    urlView: new URLSearchParams(window.location.search).get("view"),
    savedView: readDeepViewPref(prefs),
    matchMedia: window.matchMedia?.bind(window),
  });
}

// Shared loading copy with app/lineage/page.tsx's Focus View and
// app/[conf]/lineage/page.tsx (same "verifying the index matches the
// audit" wait state) -- pinned by test/lineage/routes.test.ts across
// all gated lineage/deep routes, so the pre-hydration static HTML says
// the same thing everywhere while the client-side quality-manifest
// fetch is still in flight.
const LOADING_HEADING = "研究系譜を検証しています";
const LOADING_MESSAGE = "公開索引と監査情報の一致を確認しています。";

// Ready-state hero/footer copy, ported verbatim from deep.js `init`'s
// post-gate DOM writes (`heroTitle`/`heroLede`/`heroNote` textContent).
const READY_TITLE = "1 本を深掘り（監査済み）";
const READY_LEDE = "品質監査に合格した論文の深掘り系譜を表示しています。";
const READY_NOTE = "表示中のデータは構造・識別子・関係根拠と入力ハッシュを検証済みです。";

const VIEW_BUTTONS: readonly [DeepView, string][] = [
  ["list", "関係リスト"],
  ["graph", "グラフ"],
];

export default function ConferenceDeepPage() {
  const params = useParams<{ conf: string }>();
  const slug = params.conf;
  const display = conferenceDisplayName(slug);
  const [state, setState] = useState<GateState>({ phase: "loading" });
  const [view, setViewState] = useState<DeepView>(initialView);
  const [visibleRelations, setVisibleRelations] =
    useState<ReadonlySet<Relation>>(initialVisibleRelations);
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<LineageArtifact | null>(null);
  const [artifactIssue, setArtifactIssue] = useState<ArtifactIssue>(null);
  // Ported from deep.js `init`'s `(requestedPaper || requestedArxiv) &&
  // !entry` early return (SCR-28): an explicit-but-unresolvable
  // `?paper=`/`?arxiv=` request must not fall back to the first
  // eligible paper -- it must show the same "nothing to see yet" look
  // as no row being eligible at all. See lib/lineage/core.ts
  // `resolveDeepFocusGate`'s header.
  const [focusRequestFailed, setFocusRequestFailed] = useState(false);

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
    if (selectedPaperId !== null || focusRequestFailed) return;
    const params = new URLSearchParams(window.location.search);
    const gate = resolveDeepFocusGate(
      eligibleEntries.map((pair) => pair.entry),
      { paper: params.get("paper"), arxiv: params.get("arxiv") },
    );
    if (!gate.mount) {
      setFocusRequestFailed(true);
      return;
    }
    setSelectedPaperId(gate.entry?.paper_id ?? null);
  }, [state, eligibleEntries, selectedPaperId, focusRequestFailed]);

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
    setArtifactIssue(null);
    setArtifact(null);
    async function run() {
      const fetched = await fetchLineageArtifactBytes(row.path, row.input_sha256 ?? "");
      if (cancelled) return;
      if (fetched.status === "error") {
        setArtifactIssue("verify-failed");
        return;
      }
      if (!qualityRowIsPublishable(row, { artifactSha256: fetched.data.sha256, manifestSha256 })) {
        setArtifactIssue("verify-failed");
        return;
      }
      const parsed = parseArtifact(fetched.data.raw, { kind: "deep" });
      if (!parsed) {
        setArtifactIssue("verify-failed");
        return;
      }
      // Ported from deep.js `init`'s post-parse check: the manifest
      // entry's paper_id must resolve to the artifact's own root focus
      // node, AND the artifact's own meta must agree it was built for
      // that same paper_id. Neither the manifest nor the artifact alone
      // can grant a mismatched pairing (SCR-27/28's spirit extended to
      // this specific cross-check).
      const rootFocus = resolveFocus(parsed, row.paper_id);
      if (
        !rootFocus ||
        rootFocus.id !== parsed.root ||
        parsed.meta.seed_paper_id !== row.paper_id
      ) {
        setArtifactIssue("root-mismatch");
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
  // relation, then `savePrefs()` + `syncDisplayUrl()`.
  function toggleRelation(relation: Relation): void {
    const next = new Set(visibleRelations);
    if (next.has(relation)) next.delete(relation);
    else next.add(relation);
    setVisibleRelations(next);
    saveDeepPrefs(next, view, deepPrefsStore);
    window.history.replaceState({}, "", deepDisplayUrl(window.location.href, next, view));
  }

  // Ported from deep.js `setView`.
  function setView(next: DeepView): void {
    if (view === next) return;
    setViewState(next);
    saveDeepPrefs(visibleRelations, next, deepPrefsStore);
    window.history.replaceState(
      {},
      "",
      deepDisplayUrl(window.location.href, visibleRelations, next),
    );
  }

  // A failed explicit `?paper=`/`?arxiv=` request reads the same as "no
  // row eligible yet" everywhere in this header/gate -- see
  // `focusRequestFailed`'s declaration above.
  const ready = state.phase === "ready" && !focusRequestFailed;

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
          <em>Deep Lineage</em> — {ready ? READY_TITLE : `${display} 監査待ち`}
        </h1>
        <p className="text-sm text-ink-muted">
          {ready
            ? READY_LEDE
            : `${display} の深掘り系譜データは品質監査中です。合格するまで内容は公開しません。`}
        </p>
        <p className="text-xs text-ink-subtle">
          {ready
            ? READY_NOTE
            : "構造・識別子・関係根拠と入力ハッシュの検証が完了するまで、未監査データは読み込みません。"}
        </p>
      </header>

      {!ready && (
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

      {ready && (
        <article className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <fieldset className="flex gap-1.5 border-0 p-0">
              <legend className="sr-only">表示形式</legend>
              {VIEW_BUTTONS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={view === value}
                  onClick={() => setView(value)}
                  className={`rounded-md border px-2.5 py-1 text-sm transition ${
                    view === value
                      ? "border-ink bg-ink text-paper"
                      : "border-rule text-ink-muted hover:border-ink-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </fieldset>
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
          </div>
          {artifactIssue === "verify-failed" && (
            <p role="alert" className="text-sm text-accent-strong">
              この論文の深掘り系譜を検証できませんでした。
            </p>
          )}
          {artifactIssue === "root-mismatch" && (
            <p role="alert" className="text-sm text-accent-strong">
              manifest と deep lineage の起点IDが一致しません。
            </p>
          )}
          {artifact && (
            <DeepLineageApp
              key={selectedPaperId}
              artifact={artifact}
              view={view}
              visibleRelations={visibleRelations}
              onToggleRelation={toggleRelation}
            />
          )}
        </article>
      )}
    </main>
  );
}
