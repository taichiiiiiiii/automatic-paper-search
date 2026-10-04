"use client";

import { useState } from "react";
import { API_BASE } from "../../lib/config";

type SubmitState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; ok: boolean; message: string };

export default function ThemesPage() {
  const [state, setState] = useState<SubmitState>({ status: "idle" });

  async function handleSubmit() {
    setState({ status: "loading" });
    try {
      const res = await fetch(`${API_BASE}/api/themes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: "example" }),
      });
      setState({
        status: "done",
        ok: res.ok,
        message: `HTTP ${res.status}`,
      });
    } catch (err) {
      setState({
        status: "done",
        ok: false,
        message: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return (
    <main id="main-content" className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16 sm:px-6">
      <h1 className="font-serif text-3xl font-bold tracking-tight text-ink">系譜</h1>
      <p className="text-base text-ink-muted">
        ボタンを押すと {API_BASE}/api/themes へ POST
        します（placeholder。本来のテーマ投稿フォーム・家系図表示は後続ページで実装）。
      </p>
      <button
        type="button"
        onClick={handleSubmit}
        className="w-fit rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper hover:bg-ink-muted"
      >
        テーマを送信
      </button>
      {state.status === "loading" && <p className="text-sm text-ink-subtle">送信中…</p>}
      {state.status === "done" && (
        <p className="text-sm text-ink-muted">
          結果: {state.ok ? "成功" : "失敗"} ({state.message})
        </p>
      )}
    </main>
  );
}
