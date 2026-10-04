// @vitest-environment jsdom
//
// Component-level coverage for the P2 review M4/M5 fixes in
// components/themes/ThemeRequestForm.tsx, plus the ThemesClient.tsx
// onReady redirect (both reviewed together as "M4" in
// docs/migration/safety-contracts.md / the P2 review notes):
//   M4 -- cancel a run, start a second one, let the FIRST (stale) run
//         observe "ready" -- it must never fire onReady for the
//         cancelled run's slug, and must never surface a failure for
//         the still-live second run either.
//   M4 -- cancelling a run and THEN letting its still-in-flight
//         quality-outcome check resolve "ready" must never fire
//         onReady, and must not even schedule the pre-onReady 800ms
//         delay for a run nobody is watching any more (review2.md
//         MEDIUM-1 mutants: unguarded onReady, unguarded ready-path,
//         cancel-without-invalidate).
//   M4 -- unmounting the form (closing the "about / new theme" panel
//         in ThemesClient) must stop the poll loop instead of leaking
//         it across to whatever happens next (review2.md MEDIUM-1
//         mutants: missing unmount cleanup, `while (true)`).
//   M4 -- ThemesClient's onReady callback must redirect to the
//         absolute `/themes/?theme=...` path, never a relative one
//         that resolves against whatever page happens to be current
//         (review2.md MEDIUM-1 mutant: relative redirect).
//   M5 -- two submits before the first POST resolves must send
//         exactly one `fetch` call.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeRequestForm } from "../../components/themes/ThemeRequestForm";
import { ThemesClient } from "../../components/themes/ThemesClient";
import { BASE_PATH } from "../../lib/config";
import * as dataThemes from "../../lib/data-themes";
import { ARTIFACT_VERSION, QUALITY_VERSION, type QualityRow } from "../../lib/lineage/core";
import { POLL_INTERVAL_MS, type QualityPollOutcome } from "../../lib/themes-request";

// API_BASE must be truthy for the component to take the POST path
// instead of the degraded (GitHub Issue) one -- lib/config.ts re-
// exports it from @paperpilot/core/site as a build-time constant, so
// it's mocked here rather than set via env.
vi.mock("../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/config")>();
  return { ...actual, API_BASE: "https://api.example.test" };
});

// ThemesClient reads `?theme=` via next/navigation's useSearchParams;
// no theme is requested in any test here, so the picker always falls
// back to its own default-slug logic.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

function queuedResponse(slug: string, requestId: string) {
  return new Response(JSON.stringify({ ok: true, status: "queued", slug, request_id: requestId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const REQUEST_ID_A = "theme-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_ID_B = "theme-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(() => {
  // No vitest `globals: true` in this workspace's (nonexistent) test
  // config, so @testing-library/react's auto-cleanup (which only
  // self-registers when it finds a global `afterEach`) never fires --
  // do it explicitly so each test starts from an empty document.
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ThemeRequestForm: double-submit guard (M5)", () => {
  it("two submits before the first POST resolves send exactly one fetch", async () => {
    let resolveFetch: ((value: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ThemeRequestForm onReady={vi.fn()} />);
    const input = screen.getByLabelText(/テーマを自分で生成/);
    const button = screen.getByRole("button", { name: "生成する" });

    fireEvent.change(input, { target: { value: "Flash Attention" } });
    fireEvent.click(button);
    fireEvent.click(button); // second click while the first is still pending

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Let the pending fetch resolve so no dangling timers/state remain.
    await act(async () => {
      resolveFetch?.(queuedResponse("flash-attention", REQUEST_ID_A));
      await Promise.resolve();
    });
  });

  it("disables the input and submit button while a submit is pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    render(<ThemeRequestForm onReady={vi.fn()} />);
    const input = screen.getByLabelText(/テーマを自分で生成/);
    const button = screen.getByRole("button", { name: "生成する" });

    fireEvent.change(input, { target: { value: "Flash Attention" } });
    fireEvent.click(button);

    // No @testing-library/jest-dom in this workspace's devDependencies
    // (HARD LIMIT: no new npm deps) -- assert the plain DOM property
    // instead of `.toBeDisabled()`.
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ThemeRequestForm: per-run cancellation (M4)", () => {
  it("cancelling run A then starting run B: A reaching 'ready' never fires onReady for A, and never fails B", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();

    const fetchMock = vi.fn(() => Promise.resolve(queuedResponse("theme-a", REQUEST_ID_A)));
    vi.stubGlobal("fetch", fetchMock);

    // themes-manifest.json always "contains" both slugs so the poll
    // loop moves straight to the quality check.
    vi.spyOn(dataThemes, "fetchThemesManifest").mockResolvedValue({
      status: "ok",
      data: [{ slug: "theme-a" }, { slug: "theme-b" }],
    });
    vi.spyOn(dataThemes, "fetchThemeRunStatus").mockResolvedValue(null);
    // Run A's quality check resolves "ready" (slowly, after a tick);
    // run B's stays "pending" so only A could wrongly fire onReady.
    const outcomeMock = vi
      .spyOn(dataThemes, "pollThemeQualityOutcome")
      .mockImplementation(async (slug: string) => (slug === "theme-a" ? "ready" : "pending"));

    render(<ThemeRequestForm onReady={onReady} />);
    const input = screen.getByLabelText(/テーマを自分で生成/);
    const button = screen.getByRole("button", { name: "生成する" });

    // Start run A.
    fireEvent.change(input, { target: { value: "Theme A" } });
    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // getByText itself throws if the node isn't present -- no
    // jest-dom `.toBeInTheDocument()` matcher available/needed here.
    screen.getByText(/を生成中/);

    // Cancel A via the panel's cancel button, then immediately start B.
    // Cancelling swaps the progress panel back out for the plain form
    // (a different JSX branch, i.e. a fresh <input>/<button>) -- the
    // earlier `input`/`button` references are now detached nodes, so
    // re-query them from the re-rendered DOM.
    fireEvent.click(screen.getByRole("button", { name: "キャンセルして既存テーマを見る" }));

    fetchMock.mockResolvedValue(queuedResponse("theme-b", REQUEST_ID_B));
    fireEvent.change(screen.getByLabelText(/テーマを自分で生成/), { target: { value: "Theme B" } });
    fireEvent.click(screen.getByRole("button", { name: "生成する" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Let A's in-flight pollThemeQualityOutcome("theme-a") (started
    // before cancel) resolve "ready", and run the ENTIRE rest of its
    // branch -- including the 800ms pre-onReady delay -- forward.
    // Without this, a test that only flushes microtasks never reaches
    // the line that would (incorrectly) call onReady, and passes
    // whether or not the guard is there (review2.md MEDIUM-1: this
    // exact gap is why the mutant survived).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800 + POLL_INTERVAL_MS);
    });

    expect(outcomeMock).toHaveBeenCalledWith("theme-a");
    // The bug this guards: A's "ready" outcome must never call onReady
    // for A's slug once B is the live run.
    expect(onReady).not.toHaveBeenCalledWith("theme-a");
    expect(onReady).not.toHaveBeenCalled();
    // B must still be showing its own live, non-failed progress panel
    // (A's loop invalidating itself must not touch B's state).
    screen.getByText(/「Theme B」を生成中/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancelling a run and letting its stale outcome resolve 'ready' afterward never fires onReady, and schedules no further timer (M4 review2 MEDIUM-1)", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(queuedResponse("theme-a", REQUEST_ID_A))),
    );
    vi.spyOn(dataThemes, "fetchThemesManifest").mockResolvedValue({
      status: "ok",
      data: [{ slug: "theme-a" }],
    });
    vi.spyOn(dataThemes, "fetchThemeRunStatus").mockResolvedValue(null);
    // A controllable (never auto-resolving) quality check -- lets the
    // test cancel the run WHILE pollThemeQualityOutcome("theme-a") is
    // still in flight, then resolve it afterward, to exercise exactly
    // the "stale run's outcome arrives after cancellation" race.
    // Plain no-op default (rather than `| null`) -- TypeScript's control
    // flow analysis over-narrows a `T | null` variable reassigned only
    // inside this kind of nested Promise-executor closure down to
    // `never` at the later call site in this file (reproduced in
    // isolation; a project-wide tsc quirk, not specific to this test).
    let outcomeCaptured = false;
    let resolveOutcome: (value: QualityPollOutcome) => void = () => {};
    vi.spyOn(dataThemes, "pollThemeQualityOutcome").mockImplementation(
      () =>
        new Promise<QualityPollOutcome>((resolve) => {
          resolveOutcome = resolve;
          outcomeCaptured = true;
        }),
    );

    render(<ThemeRequestForm onReady={onReady} />);
    fireEvent.change(screen.getByLabelText(/テーマを自分で生成/), { target: { value: "Theme A" } });
    fireEvent.click(screen.getByRole("button", { name: "生成する" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    screen.getByText(/を生成中/);
    // The loop is now paused awaiting pollThemeQualityOutcome -- it
    // hasn't resolved yet, so nothing beyond it has run.
    expect(outcomeCaptured).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "キャンセルして既存テーマを見る" }));
    // Cancelling must clear every timer this run owns (the 3 scheduled
    // step-advance timeouts, plus the 1s elapsed-time ticker that the
    // progress-panel unmount just tore down) -- nothing should be
    // pending right after cancel.
    expect(vi.getTimerCount()).toBe(0);

    // The run's quality check finally settles "ready" -- after cancel.
    resolveOutcome("ready");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // M4 review2 mutant "ready path unguarded (161-162)": a cancelled
    // run reaching "ready" must bail out BEFORE scheduling the
    // pre-onReady 800ms delay -- it must not even create that timer
    // for a run nobody is watching any more.
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800 + POLL_INTERVAL_MS);
    });
    // M4 review2 mutants "onReady unguarded (166)" and "cancel without
    // invalidate (230)": however it would happen, a cancelled run must
    // never fire onReady.
    expect(onReady).not.toHaveBeenCalled();
    // Cancelling reverted the panel back to the plain form.
    screen.getByRole("button", { name: "生成する" });
  });

  it("unmounting the form stops the poll loop (no further manifest/quality polls)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(queuedResponse("theme-a", REQUEST_ID_A))),
    );
    // Non-empty manifest (containing the submitted slug) and a
    // "pending" outcome -- unlike an empty manifest, this actually
    // drives the loop into its pollThemeQualityOutcome call every
    // iteration, so a leaked post-unmount loop is observable as a
    // rising call count instead of silently never reaching that call
    // at all (review2.md MEDIUM-1: the empty-manifest fixture let both
    // the "while (true)" and "no unmount cleanup" mutants survive).
    const manifestMock = vi
      .spyOn(dataThemes, "fetchThemesManifest")
      .mockResolvedValue({ status: "ok", data: [{ slug: "theme-a" }] });
    vi.spyOn(dataThemes, "fetchThemeRunStatus").mockResolvedValue(null);
    const outcomeMock = vi
      .spyOn(dataThemes, "pollThemeQualityOutcome")
      .mockResolvedValue("pending");

    const { unmount } = render(<ThemeRequestForm onReady={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/テーマを自分で生成/), { target: { value: "Theme A" } });
    fireEvent.click(screen.getByRole("button", { name: "生成する" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Sanity: the loop is genuinely live before we unmount (otherwise
    // "no more calls after unmount" would hold trivially).
    const manifestCallsBeforeUnmount = manifestMock.mock.calls.length;
    const outcomeCallsBeforeUnmount = outcomeMock.mock.calls.length;
    expect(manifestCallsBeforeUnmount).toBeGreaterThan(0);
    expect(outcomeCallsBeforeUnmount).toBeGreaterThan(0);

    unmount();

    // Advance past several poll intervals. A correctly-stopped loop
    // makes no further calls at all; a `while (true)` loop (guards
    // elsewhere intact) still makes exactly one more `fetchThemesManifest`
    // call before its OWN token guard returns; a loop that never got
    // cancelled at all (no unmount cleanup) keeps calling both on
    // every single interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * POLL_INTERVAL_MS);
    });

    expect(manifestMock.mock.calls.length).toBe(manifestCallsBeforeUnmount);
    expect(outcomeMock.mock.calls.length).toBe(outcomeCallsBeforeUnmount);
  });
});

// ---- ThemesClient: the redirect ThemeRequestForm's onReady triggers ----

const THEME_ROW: QualityRow = {
  collection_id: "theme:theme-existing",
  kind: "theme",
  slug: "theme-existing",
  label: "Existing Theme",
  path: "themes/theme-existing/lineage.json",
  availability: "ready",
  audit_status: "passed",
  freshness: "fresh",
  generated_at: "2026-08-30T00:00:00Z",
  snapshot_date: null,
  node_count: 0,
  edge_count: 0,
  artifact_schema_version: "lineage-artifact-v1",
  input_sha256: "b".repeat(64),
  audit: {
    fixture_sha256: "9".repeat(64),
    evaluated_at: "2026-08-30T00:00:00Z",
    actor: "ci:audit-v1",
    checks: [
      { name: "artifact_contract_v1", status: "passed", observed: 0, expected: 0, evidence: [] },
      {
        name: "golden_fixture",
        status: "passed",
        observed: "fixture-sha",
        expected: "matching frozen fixture",
        evidence: [],
      },
    ],
  },
};

const EMPTY_ARTIFACT = {
  schema_version: ARTIFACT_VERSION,
  root: null,
  nodes: [],
  edges: [],
  clusters: [],
  meta: {},
};

describe("ThemesClient: onReady redirect target (M4 review2 MEDIUM-1: relative ?theme= redirect)", () => {
  it("redirects to the absolute /themes/?theme=<slug> path, never a bare relative one", async () => {
    const locationStub = { href: "" };
    vi.stubGlobal("location", locationStub);

    vi.spyOn(dataThemes, "fetchThemesManifest").mockResolvedValue({
      status: "ok",
      data: [
        {
          slug: "theme-existing",
          theme: "Existing Theme",
          paper_count: 5,
          year_range: [2023, 2024],
        },
        // Not yet eligible (no quality row) -- becomes the one the
        // request form "generates" below.
        { slug: "theme-new", theme: "New Theme", paper_count: 0, year_range: [2023, 2024] },
      ],
    });
    vi.spyOn(dataThemes, "fetchThemeQualityRollup").mockResolvedValue({});
    vi.spyOn(dataThemes, "fetchLineageQualityManifest").mockResolvedValue({
      schema_version: QUALITY_VERSION,
      as_of: "2026-08-30T00:00:00Z",
      audit_version: "audit-v1",
      collections: [THEME_ROW],
    });
    vi.spyOn(dataThemes, "fetchThemeArtifact").mockResolvedValue(EMPTY_ARTIFACT);
    vi.spyOn(dataThemes, "fetchThemeRunStatus").mockResolvedValue(null);
    vi.spyOn(dataThemes, "pollThemeQualityOutcome").mockResolvedValue("ready");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(queuedResponse("theme-new", REQUEST_ID_A))),
    );

    render(<ThemesClient />);
    // Flush the real (non-fake-timer) Promise.all data-load chain
    // before switching to fake timers -- @testing-library's findBy*/
    // waitFor poll with real setTimeout, which never fires once fake
    // timers are installed unless advanced, so the "ready" phase must
    // be reached with real timers still active.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Reached the "ready" phase (gallery + picker visible) -- open the
    // about/new-theme panel, which is the only place ThemeRequestForm
    // (and its onReady prop) ever mounts.
    fireEvent.click(screen.getByRole("button", { name: /について/ }));
    fireEvent.change(screen.getByLabelText(/テーマを自分で生成/), {
      target: { value: "New Theme" },
    });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "生成する" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800 + POLL_INTERVAL_MS);
    });

    expect(locationStub.href).toBe(`${BASE_PATH}/themes/?theme=theme-new`);
    // Pin the absolute-path shape directly too (BASE_PATH is "" in
    // this build, but the mutant this guards against drops the whole
    // `/themes/` segment, not just BASE_PATH).
    expect(locationStub.href).toContain("/themes/?theme=theme-new");
  });
});
