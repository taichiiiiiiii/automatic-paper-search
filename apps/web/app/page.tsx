"use client";

import { useEffect, useState } from "react";
import type { ConferenceSummary, DataResult } from "../lib/data";
import { fetchConferences } from "../lib/data";

/**
 * P2 step-0 placeholder: real header/footer (from the root layout) +
 * the conference count read from /conferences.json via lib/data.ts.
 * A later page agent replaces this with the full S0 search-first
 * landing page (docs/index.html).
 */
export default function HomePage() {
  const [result, setResult] = useState<DataResult<ConferenceSummary[]> | { status: "loading" }>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    fetchConferences().then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalPapers =
    result.status === "ok" ? result.data.reduce((sum, c) => sum + c.papers, 0) : null;

  return (
    <main id="main-content" className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16 sm:px-6">
      <h1 className="font-serif text-3xl font-bold tracking-tight text-ink">PaperPilot</h1>
      <p className="text-base text-ink-muted">
        AI/ML トップ会議の採択論文を横断検索できます（TypeScript 移行の土台段階 —
        本来の検索トップは後続ページで実装）。
      </p>
      {result.status === "loading" && <p className="text-sm text-ink-subtle">読み込み中…</p>}
      {result.status === "ok" && (
        <p className="text-sm text-ink-muted">
          <span className="font-mono text-ink">{result.data.length}</span> 学会 ・{" "}
          <span className="font-mono text-ink">{totalPapers?.toLocaleString()}</span> 本の論文
        </p>
      )}
      {result.status === "error" && (
        <p className="text-sm text-accent-strong" role="alert">
          学会一覧の読み込みに失敗しました: {result.error}
        </p>
      )}
    </main>
  );
}
