"use client";

/**
 * Port of docs/assets/theme.js's init(): loads the manifest + quality
 * rollup + shared lineage-quality read model, resolves `?theme=`
 * against the STRICT quality-eligible subset only (SCR-31/32), and
 * renders the gallery / request form / chronological tree.
 *
 * `?theme=` is read client-side via `useSearchParams` -- per the P2
 * brief, this page does no per-theme static generation; every slug is
 * resolved and gated at runtime in the browser, exactly like the
 * original docs/themes/index.html.
 */
import { useSearchParams } from "next/navigation";
import { lazy, Suspense, useEffect, useState } from "react";
import { API_BASE, BASE_PATH } from "../../lib/config";
import {
  fetchLineageQualityManifest,
  fetchThemeApiAccepting,
  fetchThemeArtifact,
  fetchThemeQualityRollup,
  fetchThemesManifest,
  themeFallbackReason,
} from "../../lib/data-themes";
import {
  fetchThemeCodeLinks,
  fetchThemeNewPapers,
  sideFilesFromManifest,
  type ThemeCodeLinks,
  type ThemeNewPapers,
} from "../../lib/themes-feed";
import { dataDateOf } from "../../lib/themes-format";
import type { ThemeManifestEntry, ThemeQualityRollup } from "../../lib/themes-gallery";
import { eligibleThemeManifest, pickDefaultSlug, safeDisplayCount } from "../../lib/themes-gallery";
import type { LineageArtifact } from "../../lib/themes-quality";
import { SLUG_RE } from "../../lib/themes-slug";
import { PublicationNotice } from "../lineage/publication-badge";
import { LineageTree } from "./LineageTree";
import { ThemeCodeLinksSection, ThemeNewPapersSection } from "./ThemeFeedSections";
import { ThemeGallery } from "./ThemeGallery";

// The request form (~550 lines with its polling logic) is only needed
// once the reader opens 「新しいテーマを依頼」 or no theme is published, so
// it is split out of the theme page's first-load chunk.
const ThemeRequestForm = lazy(() =>
  import("./ThemeRequestForm").then((m) => ({ default: m.ThemeRequestForm })),
);

type ViewState =
  | { phase: "loading" }
  // LOW fix: `themes-manifest.json` itself failing to fetch (network
  // error, non-2xx) used to collapse into the same "not-ready" state
  // as "zero themes have passed quality audit yet" -- both rendered
  // the identical 系譜は品質監査中です copy, so an operator-visible
  // outage looked indistinguishable from the ordinary pre-launch
  // state. Per CLAUDE.md's "always render a distinct error state,
  // never empty-as-error", a fetch failure gets its own phase.
  | { phase: "error" }
  // No theme has a published (audited/unaudited) quality row at all, OR the
  // slug this render landed on failed its own gate at fetch time (a row
  // can go stale between audit publication and artifact fetch) --
  // either way, the whole interactive surface stays closed (SCR-22).
  | { phase: "not-ready" }
  | {
      phase: "ready";
      manifest: ThemeManifestEntry[];
      qualityRollup: ThemeQualityRollup;
      currentSlug: string;
      artifact: LineageArtifact;
      slugFallback: {
        requested: string;
        fallbackTheme: string;
        reason: "unknown" | "blocked";
      } | null;
    };

function entryTheme(manifest: ThemeManifestEntry[], slug: string): string {
  return manifest.find((e) => e.slug === slug)?.theme || slug;
}

// M4 fix: a relative `?theme=...` resolved against whatever the
// browser's current URL happened to be -- after a next/link client-side
// nav elsewhere and back, or any path that isn't exactly `/themes/`,
// that landed on the wrong page (e.g. `/?theme=...`) instead of the
// theme lineage view. Always target the absolute `/themes/` path.
function redirectToTheme(slug: string): void {
  window.location.href = `${BASE_PATH}/themes/?theme=${encodeURIComponent(slug)}`;
}

/**
 * The theme request form, shown only while the Worker reports
 * `accepting: true` on /api/health (design doc 41 D1: requested themes
 * are published as unaudited right away, so the form no longer waits for
 * an eligible lineage). Fail closed: while checking nothing is shown, and
 * a paused/unreachable Worker shows a short notice instead of the form.
 */
function ThemeRequestGate() {
  const [accepting, setAccepting] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchThemeApiAccepting(API_BASE).then((ok) => {
      if (!cancelled) setAccepting(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (accepting === null) return null;
  if (!accepting) {
    return (
      <p className="mt-4 text-sm text-ink-subtle" data-theme-request="closed">
        現在、新しいテーマの受付を停止しています。
      </p>
    );
  }
  return (
    <Suspense
      fallback={
        <p role="status" className="mt-4 text-sm text-ink-subtle">
          依頼フォームを読み込み中…
        </p>
      }
    >
      <ThemeRequestForm onReady={redirectToTheme} />
    </Suspense>
  );
}

export function ThemesClient() {
  const searchParams = useSearchParams();
  const requestedRaw = searchParams.get("theme");
  const requested = requestedRaw && SLUG_RE.test(requestedRaw) ? requestedRaw : null;

  const [state, setState] = useState<ViewState>({ phase: "loading" });
  const [aboutOpen, setAboutOpen] = useState(false);
  const [dismissedFallback, setDismissedFallback] = useState(false);
  // R4-3: optional side files of the shown theme (never block the page).
  const [extras, setExtras] = useState<{
    slug: string;
    newPapers: ThemeNewPapers | null;
    codeLinks: ThemeCodeLinks | null;
  } | null>(null);
  const readySlug = state.phase === "ready" ? state.currentSlug : null;
  // Only the manifest decides which side files exist: requesting a file that
  // is not there logs a console 404 even when the fetch error is caught.
  const readyEntry =
    state.phase === "ready" ? state.manifest.find((e) => e.slug === state.currentSlug) : undefined;
  const { newPapers: wantNewPapers, codeLinks: wantCodeLinks } = sideFilesFromManifest(readyEntry);

  useEffect(() => {
    if (!readySlug) return;
    let cancelled = false;
    (async () => {
      const [newPapers, codeLinks] = await Promise.all([
        wantNewPapers ? fetchThemeNewPapers(readySlug) : null,
        wantCodeLinks ? fetchThemeCodeLinks(readySlug) : null,
      ]);
      if (!cancelled) setExtras({ slug: readySlug, newPapers, codeLinks });
    })();
    return () => {
      cancelled = true;
    };
  }, [readySlug, wantNewPapers, wantCodeLinks]);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    (async () => {
      const [manifestResult, qualityRollup, lineageQuality] = await Promise.all([
        fetchThemesManifest(),
        fetchThemeQualityRollup(),
        fetchLineageQualityManifest(),
      ]);
      if (cancelled) return;
      if (manifestResult.status === "error") {
        setState({ phase: "error" });
        return;
      }
      const rawManifest = manifestResult.data;
      // Only strict quality-manifest rows with a published tier may
      // enter the picker/gallery or become a default selection -- the
      // legacy manifest and _quality.json rollup are discovery/
      // telemetry inputs, never publication gates (SCR-32).
      const eligible = eligibleThemeManifest(rawManifest, lineageQuality);
      if (eligible.length === 0) {
        setState({ phase: "not-ready" });
        return;
      }
      const known = new Set(eligible.map((e) => e.slug));
      const currentSlug =
        requested && known.has(requested) ? requested : pickDefaultSlug(eligible, qualityRollup);
      if (!currentSlug) {
        setState({ phase: "not-ready" });
        return;
      }
      const artifact = await fetchThemeArtifact(currentSlug, lineageQuality);
      if (cancelled) return;
      if (!artifact) {
        setState({ phase: "not-ready" });
        return;
      }
      setDismissedFallback(false);
      setState({
        phase: "ready",
        manifest: eligible,
        qualityRollup,
        currentSlug,
        artifact,
        slugFallback:
          requested && !known.has(requested)
            ? {
                requested,
                fallbackTheme: entryTheme(eligible, currentSlug),
                reason: themeFallbackReason(lineageQuality, requested),
              }
            : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [requested]);

  useEffect(() => {
    if (state.phase !== "ready") return;
    const theme =
      typeof state.artifact.meta.theme === "string" ? state.artifact.meta.theme : "Theme";
    const want = `${theme} — テーマ別の系譜 | PaperPilot`;
    const apply = () => {
      if (document.title !== want) document.title = want;
    };
    apply();
    // Next re-commits the page's static <title> (metadata) after hydration.
    // When the lineage loads first -- warm cache, slow main thread -- that
    // late commit overwrote the theme title with the generic one (seen in
    // WebKit E2E), so keep re-applying it while this theme is shown.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = "テーマ別の系譜 | PaperPilot";
    };
  }, [state]);

  if (state.phase === "loading") {
    return (
      // min-h reserves roughly the header + toolbar + tree height, so the
      // footer does not jump when the lineage arrives (CLS).
      <section
        role="status"
        aria-live="polite"
        className="min-h-[80vh] px-4 py-16 text-center sm:px-6"
      >
        <div
          className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-rule border-t-accent"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm text-ink-subtle">家系図を描画中…</p>
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section
        role="alert"
        aria-live="polite"
        className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6"
      >
        <h2 className="font-serif text-xl font-semibold text-ink">
          テーマ一覧を取得できませんでした
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          通信エラー、または一時的な不調の可能性があります。時間をおいて再度お試しください。
        </p>
        <p className="mt-4 text-sm">
          <a href="/" className="text-accent-strong underline">
            論文カタログへ戻る
          </a>
        </p>
      </section>
    );
  }

  if (state.phase === "not-ready") {
    return (
      <section
        role="status"
        aria-live="polite"
        className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6"
      >
        <h2 className="font-serif text-xl font-semibold text-ink">系譜は品質監査中です</h2>
        <p className="mt-2 text-sm text-ink-muted">
          公開基準を満たしたコレクションはまだありません。自動検査に合格するまでテーマ名・件数・グラフ・操作は公開しません。
        </p>
        <div className="mx-auto mt-4 max-w-md text-left">
          <ThemeRequestGate />
        </div>
        <p className="mt-4 text-sm">
          <a href="/" className="text-accent-strong underline">
            論文カタログへ戻る
          </a>
        </p>
      </section>
    );
  }

  const { manifest, qualityRollup, currentSlug, artifact, slugFallback } = state;
  const shownExtras = extras && extras.slug === currentSlug ? extras : null;
  const entry = manifest.find((e) => e.slug === currentSlug);
  const yearRange = entry?.year_range ? `${entry.year_range[0]}–${entry.year_range[1]}` : "—";
  const count = safeDisplayCount(entry?.paper_count ?? artifact.nodes.length);
  const dataDate = dataDateOf(artifact.meta.generated_at);
  const keywords = Array.isArray(artifact.meta.keywords)
    ? (artifact.meta.keywords as unknown[])
    : [];

  const themeName = entry?.theme || entryTheme(manifest, currentSlug);
  // The keywords themselves (they used to show only as「キーワード 1 件」).
  const keywordList = keywords.filter((k): k is string => typeof k === "string" && k.length > 0);
  const keywordText =
    keywordList.slice(0, 5).join(", ") +
    (keywordList.length > 5 ? ` ほか ${keywordList.length - 5} 件` : "");
  const stats = [yearRange, `${count} 論文`, `${safeDisplayCount(artifact.edges.length)} 関係`];

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-10">
      {/* UX audit (design 53 §系譜ページ): the theme name is the page's
          h1 (it used to be only on a gallery card under a generic title),
          followed by the tier and a one-line summary; the theme picker
          comes next, then the graph. */}
      <header className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <nav
            aria-label="パンくずリスト"
            className="flex flex-wrap items-center gap-2 text-sm text-ink-subtle"
          >
            <a href="/">PaperPilot</a>
            <span aria-hidden="true">/</span>
            <span>テーマ別の系譜</span>
          </nav>
          {/* R2 UX P2-10: the request form used to hide behind a small
              "ⓘ について / ✨ 新規テーマ" toggle; it stays a visible action
              but is secondary to reading the lineage. */}
          <button
            type="button"
            aria-expanded={aboutOpen}
            aria-controls="hero-details"
            onClick={() => setAboutOpen((v) => !v)}
            className="inline-flex min-h-9 items-center rounded-md border border-accent px-3 py-1 text-xs font-medium text-accent-strong hover:bg-accent/10 sm:text-sm"
          >
            {aboutOpen ? "✕ 閉じる" : "＋ 新しいテーマを依頼"}
          </button>
        </div>
        <h1 className="mt-2 font-serif text-2xl font-bold text-ink" data-theme-title>
          {themeName} <span className="text-lg font-semibold text-ink-muted">の系譜</span>
          <span className="sr-only">（時系列の家系図）</span>
        </h1>
        {entry?.publication_tier && (
          <div className="mt-2">
            <PublicationNotice tier={entry.publication_tier} />
          </div>
        )}
        <p className="mt-2 text-sm text-ink-muted" data-theme-stats>
          {stats.join("・")}
          <span
            className="ml-2 text-ink-subtle"
            data-data-date={dataDate ?? ""}
            title="この系譜を生成した日（引用数などはこの日の値）"
          >
            （データの日付 {dataDate ?? "不明"}
            {keywordText ? `・検索キーワード: ${keywordText}` : ""}）
          </span>
        </p>
        <p className="mt-1 text-xs text-ink-subtle" data-node-selection>
          論文は、テーマの代表的な論文から引用をたどって集め、テーマから外れるものは除いています。
          <a href="/how-it-works/" className="ml-1 text-accent-strong underline">
            仕組み
          </a>
        </p>
        {aboutOpen && (
          <div id="hero-details" className="mt-3 rounded-md border border-rule bg-surface p-4">
            <p className="text-sm text-ink-muted">
              系譜データは、構造・識別子・関係根拠を検査する自動検査に合格したものだけ公開します。
            </p>
            <p className="mt-1 text-sm text-ink-subtle">
              人が内容を確認した系譜は「監査済み」、まだ確認していない系譜は「未監査（自動生成）」と表示します。依頼したテーマは、自動検査に合格するとまず未監査として公開されます。
            </p>
            <ThemeRequestGate />
          </div>
        )}
      </header>

      {slugFallback && !dismissedFallback && (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-rule bg-surface-2 px-3 py-2 text-sm"
        >
          <span aria-hidden="true">⚠️</span>
          <span className="flex-1">
            {slugFallback.reason === "blocked" ? (
              <>
                テーマ "{slugFallback.requested}"
                は生成されましたが、自動検査に合格しなかったため非公開です。代わりに "
                {slugFallback.fallbackTheme}" を表示しています。
              </>
            ) : (
              <>
                テーマ "{slugFallback.requested}" は存在しません。代わりに "
                {slugFallback.fallbackTheme}" を表示しています。
              </>
            )}
          </span>
          {slugFallback.reason !== "blocked" && (
            <a
              href={`https://github.com/taichiiiiiiii/automatic-paper-search/issues/new?labels=theme-request&title=${encodeURIComponent(`[theme request] ${slugFallback.requested}`)}`}
              target="_blank"
              rel="noopener"
              className="whitespace-nowrap text-accent-strong underline"
            >
              ✨ Issue でリクエスト
            </a>
          )}
          <button
            type="button"
            aria-label="閉じる"
            onClick={() => setDismissedFallback(true)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-ink-subtle"
          >
            ✕
          </button>
        </div>
      )}

      <h2 className="text-xs font-semibold text-ink-subtle" id="theme-gallery-heading">
        テーマを切り替える（全 {manifest.length} 件）
        {manifest.length > 1 && (
          <span className="ml-2 font-normal sm:hidden">横にスクロールできます →</span>
        )}
      </h2>
      <ThemeGallery manifest={manifest} qualityRollup={qualityRollup} currentSlug={currentSlug} />

      {artifact.nodes.length === 0 ? (
        <p className="mt-8 text-sm text-ink-muted">
          このテーマにはノードがありません（検索結果が空だった可能性あり）。
        </p>
      ) : (
        // key={currentSlug}: remount (not update) when the theme changes so
        // LineageTree's filter/export/onboarding/minimap state always
        // starts fresh for the newly-selected theme instead of carrying
        // over the previous theme's search query / year range / etc.
        <LineageTree
          key={currentSlug}
          artifact={artifact}
          slug={currentSlug}
          themeName={themeName}
          codeLinks={shownExtras?.codeLinks ?? null}
        />
      )}

      {/* Secondary material folds into disclosures under the graph. */}
      <div className="mt-8 space-y-3" data-theme-extras>
        <ThemeNewPapersSection
          slug={currentSlug}
          data={shownExtras?.newPapers ?? null}
          nodes={artifact.nodes}
        />
        <ThemeCodeLinksSection links={shownExtras?.codeLinks ?? null} nodes={artifact.nodes} />
      </div>

      <footer className="mt-10 text-xs text-ink-subtle">
        自動検査に合格した系譜のみ公開します（人が確認したものは「監査済み」、未確認のものは「未監査（自動生成）」）
      </footer>
    </div>
  );
}
