"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AuditStatus } from "../../../components/lineage/audit-status";
import { LineageGraph } from "../../../components/lineage/graph/lineage-graph-app";
import { fetchLineageArtifactBytes, fetchLineageQualityManifest } from "../../../lib/data-lineage";
import { conferenceDisplayName } from "../../../lib/lineage/conference-name";
import {
  type LineageArtifact,
  parseArtifact,
  qualityRowIsEligible,
  qualityRowIsPublishable,
  resolveLineageFocusGate,
  resolveQualityCollection,
} from "../../../lib/lineage/core";

/**
 * Ported from docs/<conf>/lineage.html + docs/assets/lineage.js `init`.
 *
 * Gate: never fetches `lineage.json` unless the quality manifest says
 * this conference's row is `ready`+`passed` with a valid audit
 * contract (SCR-25); a failed quality fetch collapses to the exact same
 * "not ready" UI as "not yet eligible" -- intentionally, matching
 * lineage.js (`loadQualityManifest` failure -> `qualityRow` is null ->
 * `qualityRowIsEligible(null)` is false) and the fail-closed contract:
 * there is no safe "retry" state to show differently here, because
 * telling an attacker "the manifest fetch itself failed" vs "this row
 * is not eligible" leaks nothing useful but complicates the UI for no
 * benefit. (This differs from lib/data.ts's general "always render a
 * distinct error state" convention -- a deliberate exception for this
 * safety-gated path, not an oversight.)
 *
 * The ready state (<LineageGraph>, components/lineage/graph/
 * lineage-graph-app.tsx) now covers all four modes -- Topics / Tree /
 * Timeline SVG graph layouts plus the list view ported earlier -- but
 * 0 conference rows are eligible today, so this has only been
 * exercised against a fixture artifact in
 * test/lineage/graph/view-model.test.ts, not real data. See the final
 * report for the full list of smaller parity gaps (tooltip anchoring,
 * scroll-to-focus, measured card heights).
 */
type GateState =
  | { phase: "loading" }
  | { phase: "pending" }
  | { phase: "ready"; artifact: LineageArtifact };

// Shared loading copy with app/lineage/page.tsx's Focus View (same
// "verifying the index matches the audit" wait state) -- pinned by
// test/lineage/routes.test.ts across all gated lineage/deep routes, so
// the pre-hydration static HTML says the same thing everywhere while
// the client-side quality-manifest fetch is still in flight.
const LOADING_HEADING = "研究系譜を検証しています";
const LOADING_MESSAGE = "公開索引と監査情報の一致を確認しています。";

export default function ConferenceLineagePage() {
  const params = useParams<{ conf: string }>();
  const slug = params.conf;
  const display = conferenceDisplayName(slug);
  const [state, setState] = useState<GateState>({ phase: "loading" });
  const [focusId, setFocusId] = useState<string | null>(null);
  // P2 review LOW-1: stores `resolveLineageFocusGate`'s own `mount`
  // decision directly, rather than the inverse of a separately-stored
  // `notFound` boolean -- `mount` is the ONE field the render below
  // branches on (ported: `{gate.mount ? <LineageGraph/> : notice}`), so
  // there is no second piece of state that could ever drift from it.
  const [focusMount, setFocusMount] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const path = `${slug}/lineage.json`;
      const quality = await fetchLineageQualityManifest();
      if (cancelled) return;
      if (quality.status === "error") {
        setState({ phase: "pending" });
        return;
      }
      const row = resolveQualityCollection(quality.data, { kind: "conference", slug, path });
      if (!qualityRowIsEligible(row)) {
        setState({ phase: "pending" });
        return;
      }
      const fetched = await fetchLineageArtifactBytes(path, row?.input_sha256 ?? "");
      if (cancelled) return;
      if (fetched.status === "error") {
        setState({ phase: "pending" });
        return;
      }
      if (!qualityRowIsPublishable(row, { artifactSha256: fetched.data.sha256 })) {
        setState({ phase: "pending" });
        return;
      }
      const artifact = parseArtifact(fetched.data.raw, { kind: "conference" });
      if (!artifact) {
        setState({ phase: "pending" });
        return;
      }
      // P2 review LOW: ported from lineage.js `init`'s `if
      // (!state.data.root) { ...; return; }` -- that check sits BEFORE
      // the lines that unhide the ready UI and stamp the "（監査済み）"
      // heading, so an empty artifact (no root, e.g. a lineage-quality
      // row that passed audit over a structurally-empty graph) never
      // reaches the ready look at all; it leaves the page showing
      // exactly the same copy as "not ready yet". This port must not
      // show "（監査済み）" over an empty graph just because `artifact`
      // itself parsed.
      if (!artifact.root) {
        setState({ phase: "pending" });
        return;
      }
      const requested = new URLSearchParams(window.location.search).get("focus");
      // M7 (P2 review): an unknown `?focus=` must not fall back to
      // drawing the root graph -- see lib/lineage/core.ts
      // `resolveLineageFocusGate`'s header.
      const gate = resolveLineageFocusGate(artifact, requested);
      setFocusMount(gate.mount);
      setFocusId(gate.focusId);
      setState({ phase: "ready", artifact });
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [slug]);

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
          / Lineage
        </nav>
        <h1 className="font-serif text-2xl font-bold text-ink">
          <em>Lineage</em> —{" "}
          {state.phase === "ready" ? `${display}（監査済み）` : `${display} 監査待ち`}
        </h1>
        <p className="text-sm text-ink-muted">
          {state.phase === "ready"
            ? "品質監査に合格した論文間の関係を表示しています。"
            : `${display} の系譜データは品質監査中です。合格するまで内容は公開しません。`}
        </p>
        <p className="text-xs text-ink-subtle">
          {state.phase === "ready"
            ? "表示中のデータは構造・識別子・関係根拠と入力ハッシュを検証済みです。"
            : "構造・識別子・関係根拠と入力ハッシュの検証が完了するまで、未監査データは読み込みません。"}
        </p>
      </header>

      {state.phase !== "ready" && (
        <AuditStatus
          heading={state.phase === "loading" ? LOADING_HEADING : "公開監査を待っています"}
          message={
            state.phase === "loading"
              ? LOADING_MESSAGE
              : "構造・識別子・関係根拠の検査が完了するまで、検索・表示切替・グラフを利用できません。"
          }
          backHref={`/${slug}/`}
          backLabel={`${display} の論文カタログへ戻る`}
        />
      )}

      {state.phase === "ready" && (
        <article>
          {focusMount ? (
            <LineageGraph artifact={state.artifact} initialFocusId={focusId} />
          ) : (
            <p role="alert" className="mb-4 text-sm text-accent-strong">
              指定された論文IDはこの監査済み系譜にありません。
            </p>
          )}
        </article>
      )}
    </main>
  );
}
