"use client";

import { useEffect, useState } from "react";
import { AuditStatus } from "../../components/lineage/audit-status";
import { FocusView } from "../../components/lineage/focus/FocusView";
import { BASE_PATH } from "../../lib/config";
import { isValidPaperId, readSinglePaperParam } from "../../lib/lineage/pilot-index";
import type { FocusViewState, Release } from "../../lib/lineage/v2";
import {
  loadOwner,
  loadVerifiedRelease,
  readState,
  selectFocusProjection,
} from "../../lib/lineage/v2";

/**
 * Ported from docs/lineage/index.html + docs/assets/lineage-focus.js
 * `start()` -- the full, verified "Focus View". `?paper=` validation
 * (`readSinglePaperParam`/`isValidPaperId`, from lib/lineage/pilot-index.ts)
 * happens before any fetch, exactly as the original's `start()` does.
 *
 * This page owns the SAME single codepath `start()` does: validate
 * `?paper=` -> load+verify the five-document release
 * (`loadVerifiedRelease`, lib/lineage/v2/loader.ts) -> compute the
 * FIRST `FocusViewState`/projection -> only render the real view
 * (`FocusView`) if that first projection also succeeds. Every
 * fail-closed message below matches `start()`'s/`closed()`'s copy
 * verbatim, including the 30s-timeout message a previous, simplified
 * port of this page was missing. From the moment `FocusView` mounts,
 * IT owns every subsequent state transition (controls, centering,
 * pagination, popstate) -- see its own module doc.
 */
type GateState =
  | { phase: "loading" }
  | { phase: "closed"; message: string }
  | { phase: "ready"; release: Release; initialState: FocusViewState };

const LOADING_MESSAGE = "公開索引と監査情報の一致を確認しています。";
const LOADING_HEADING = "研究系譜を検証しています";
const CLOSED_HEADING = "監査済みの系譜は表示できません";

function mobileMatches(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 720px)").matches === true
  );
}

function loadPreferences(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem("paperpilotLineageFocusV1");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export default function LineageFocusPage() {
  const [state, setState] = useState<GateState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    const owner = loadOwner();

    async function run() {
      const paperId = readSinglePaperParam(window.location.search);
      if (!isValidPaperId(paperId)) {
        setState({
          phase: "closed",
          message:
            "有効な paper ID が指定されていません。論文一覧から監査済みの系譜を開いてください。",
        });
        return;
      }
      try {
        const release = await loadVerifiedRelease(paperId, owner, {
          origin: window.location.origin,
          rootUrl: new URL(`${BASE_PATH}/`, window.location.origin).href,
          fetchImpl: (url, init) => window.fetch(url, init),
        });
        if (cancelled) return;
        if (!owner.isActive()) {
          setState({
            phase: "closed",
            message: "監査情報の確認が制限時間内に完了しなかったため、系譜を表示していません。",
          });
          return;
        }
        owner.finish();
        if (!release) {
          setState({
            phase: "closed",
            message: "この論文には公開可能な監査済み系譜がありません。",
          });
          return;
        }
        const initialState = readState(release, {
          params: new URLSearchParams(window.location.search),
          prefs: loadPreferences(),
          mobile: mobileMatches(),
        });
        const projection = initialState && selectFocusProjection(release, initialState);
        if (!projection || !initialState) {
          setState({
            phase: "closed",
            message: "指定された focus または表示条件を安全に復元できませんでした。",
          });
          return;
        }
        setState({ phase: "ready", release, initialState });
      } catch {
        if (cancelled) return;
        owner.finish();
        setState({
          phase: "closed",
          message: "監査情報の一致を確認できなかったため、系譜を表示していません。",
        });
      }
    }
    run();
    return () => {
      cancelled = true;
      owner.abandon();
    };
  }, []);

  if (state.phase === "ready") {
    return (
      <main id="main-content" className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
        <FocusView release={state.release} initialState={state.initialState} />
      </main>
    );
  }

  return (
    <main id="main-content" className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16 sm:px-6">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
        AUDITED LINEAGE / FOCUS VIEW
      </p>
      <AuditStatus
        heading={state.phase === "loading" ? LOADING_HEADING : CLOSED_HEADING}
        message={state.phase === "loading" ? LOADING_MESSAGE : state.message}
        backHref="/"
        backLabel="論文を探し直す →"
        headingLevel={1}
      />
    </main>
  );
}
