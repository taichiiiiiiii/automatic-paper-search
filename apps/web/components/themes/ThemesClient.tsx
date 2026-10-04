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
import { useEffect, useState } from "react";
import {
  fetchLineageQualityManifest,
  fetchThemeArtifact,
  fetchThemeQualityRollup,
  fetchThemesManifest,
} from "../../lib/data-themes";
import type { ThemeManifestEntry, ThemeQualityRollup } from "../../lib/themes-gallery";
import { eligibleThemeManifest, pickDefaultSlug, safeDisplayCount } from "../../lib/themes-gallery";
import type { LineageArtifact } from "../../lib/themes-quality";
import { SLUG_RE } from "../../lib/themes-slug";
import { LineageTree } from "./LineageTree";
import { ThemeGallery } from "./ThemeGallery";
import { ThemeRequestForm } from "./ThemeRequestForm";

type ViewState =
  | { phase: "loading" }
  // No theme has an eligible (ready+passed) quality row at all, OR the
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
      slugFallback: { requested: string; fallbackTheme: string } | null;
    };

function entryTheme(manifest: ThemeManifestEntry[], slug: string): string {
  return manifest.find((e) => e.slug === slug)?.theme || slug;
}

export function ThemesClient() {
  const searchParams = useSearchParams();
  const requestedRaw = searchParams.get("theme");
  const requested = requestedRaw && SLUG_RE.test(requestedRaw) ? requestedRaw : null;

  const [state, setState] = useState<ViewState>({ phase: "loading" });
  const [aboutOpen, setAboutOpen] = useState(false);
  const [dismissedFallback, setDismissedFallback] = useState(false);

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
      const rawManifest = manifestResult.status === "ok" ? manifestResult.data : [];
      // Only strict quality-manifest rows that are ready+passed may
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
            ? { requested, fallbackTheme: entryTheme(eligible, currentSlug) }
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
    document.title = `${theme} — Theme Lineage — PaperPilot`;
    return () => {
      document.title = "系譜の公開準備状況 | PaperPilot";
    };
  }, [state]);

  if (state.phase === "loading") {
    return (
      <section role="status" aria-live="polite" className="px-4 py-16 text-center sm:px-6">
        <div
          className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-rule border-t-accent"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm text-ink-subtle">家系図を描画中…</p>
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
          公開基準を満たしたコレクションはまだありません。監査に合格するまでテーマ名・件数・グラフ・操作は公開しません。
        </p>
        <p className="mt-4 text-sm">
          <a href="/" className="text-accent underline">
            論文カタログへ戻る
          </a>
        </p>
      </section>
    );
  }

  const { manifest, qualityRollup, currentSlug, artifact, slugFallback } = state;
  const entry = manifest.find((e) => e.slug === currentSlug);
  const yearRange = entry?.year_range ? `${entry.year_range[0]}–${entry.year_range[1]}` : "—";
  const count = safeDisplayCount(entry?.paper_count ?? artifact.nodes.length);
  const keywords = Array.isArray(artifact.meta.keywords)
    ? (artifact.meta.keywords as unknown[])
    : [];

  return (
    <div className="px-4 py-10 sm:px-6">
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-subtle">
          <a href="/">PaperPilot</a>
          <span>/</span>
          <span>Theme Lineage</span>
          <button
            type="button"
            aria-expanded={aboutOpen}
            aria-controls="hero-details"
            onClick={() => setAboutOpen((v) => !v)}
            className="rounded-md border border-rule px-2 py-1 text-xs text-ink-muted hover:border-rule-strong"
          >
            {aboutOpen ? "✕ 閉じる" : "ⓘ について / ✨ 新規テーマ"}
          </button>
        </div>
        <h1 className="mt-2 font-serif text-2xl font-bold text-ink">
          <em>Lineage</em> — Theme Lineage: テーマで時系列家系図
        </h1>
        {aboutOpen && (
          <div id="hero-details" className="mt-3 rounded-md border border-rule bg-surface p-4">
            <p className="text-sm text-ink-muted">
              系譜データは、構造・識別子・関係根拠を検査する品質監査を通過したものだけ公開します。
            </p>
            <p className="mt-1 text-sm text-ink-subtle">
              現在の監査に合格したコレクションがない場合、テーマ名・件数・フィルタ・ダウンロード操作は表示されません。
            </p>
            <ThemeRequestForm
              onReady={(slug) => {
                window.location.href = `?theme=${encodeURIComponent(slug)}`;
              }}
            />
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
            テーマ "{slugFallback.requested}" は存在しません。代わりに "{slugFallback.fallbackTheme}
            " を表示しています。
          </span>
          <a
            href={`https://github.com/taichiiiiiiii/automatic-paper-search/issues/new?labels=theme-request&title=${encodeURIComponent(`[theme request] ${slugFallback.requested}`)}`}
            target="_blank"
            rel="noopener"
            className="whitespace-nowrap text-accent underline"
          >
            ✨ Issue でリクエスト
          </a>
          <button
            type="button"
            aria-label="閉じる"
            onClick={() => setDismissedFallback(true)}
            className="text-ink-subtle"
          >
            ✕
          </button>
        </div>
      )}

      <ThemeGallery manifest={manifest} qualityRollup={qualityRollup} currentSlug={currentSlug} />

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-ink-muted">
        <span className="rounded-full bg-surface-2 px-2 py-1">📅 {yearRange}</span>
        <span className="rounded-full bg-surface-2 px-2 py-1">📄 {count} papers</span>
        {keywords.length > 0 && (
          <span className="rounded-full bg-surface-2 px-2 py-1" title={keywords.join(", ")}>
            🔍 {keywords.length} keywords
          </span>
        )}
      </div>

      {artifact.nodes.length === 0 ? (
        <p className="mt-8 text-sm text-ink-muted">
          このテーマにはノードがありません（検索結果が空だった可能性あり）。
        </p>
      ) : (
        // key={currentSlug}: remount (not update) when the theme changes so
        // LineageTree's filter/export/onboarding/minimap state always
        // starts fresh for the newly-selected theme instead of carrying
        // over the previous theme's search query / year range / etc.
        <LineageTree key={currentSlug} artifact={artifact} slug={currentSlug} />
      )}

      <footer className="mt-10 text-xs text-ink-subtle">
        品質監査に合格した系譜のみ公開します
      </footer>
    </div>
  );
}
