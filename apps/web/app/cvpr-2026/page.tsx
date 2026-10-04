"use client";

import { useEffect, useState } from "react";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; count: number }
  | { status: "error"; message: string };

export default function Cvpr2026Page() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/placeholder/cvpr-2026.json")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: unknown) => {
        if (cancelled) return;
        const count = Array.isArray(data) ? data.length : 0;
        setState({ status: "loaded", count });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "unknown error",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16">
      <h1 className="text-3xl font-bold tracking-tight">CVPR 2026</h1>
      {state.status === "loading" && <p className="text-sm text-slate-500">読み込み中…</p>}
      {state.status === "loaded" && (
        <p className="text-sm text-slate-500">{state.count} 件取得（placeholder）</p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-red-600">読み込み失敗: {state.message}</p>
      )}
    </main>
  );
}
