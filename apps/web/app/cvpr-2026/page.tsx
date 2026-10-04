"use client";

import { useEffect, useState } from "react";
import type { DataResult, Paper } from "../../lib/data";
import { fetchConferencePapers } from "../../lib/data";

/**
 * Minimal placeholder: fetches the real /cvpr-2026/papers.json (copied
 * from docs/ by scripts/copy-data.ts) via lib/data.ts and shows the
 * paper count. A later page agent replaces this with the full catalog
 * page (filter bar, search, tag chips -- docs/cvpr-2026/index.html).
 */
export default function Cvpr2026Page() {
  const [result, setResult] = useState<DataResult<Paper[]> | { status: "loading" }>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    fetchConferencePapers("cvpr-2026").then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main id="main-content" className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16 sm:px-6">
      <h1 className="font-serif text-3xl font-bold tracking-tight text-ink">CVPR 2026</h1>
      {result.status === "loading" && <p className="text-sm text-ink-subtle">読み込み中…</p>}
      {result.status === "ok" && (
        <p className="text-sm text-ink-muted">
          <span className="font-mono text-ink">{result.data.length}</span>{" "}
          件の採択論文（placeholder）
        </p>
      )}
      {result.status === "error" && (
        <p className="text-sm text-accent-strong" role="alert">
          論文一覧の読み込みに失敗しました: {result.error}
        </p>
      )}
    </main>
  );
}
