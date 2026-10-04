// @vitest-environment jsdom
//
// Component-level coverage for the P2 review M4/M5 fixes in
// components/themes/ThemeRequestForm.tsx:
//   M4 -- cancel a run, start a second one, let the FIRST (stale) run
//         observe "ready" -- it must never fire onReady for the
//         cancelled run's slug, and must never surface a failure for
//         the still-live second run either.
//   M4 -- unmounting the form (closing the "about / new theme" panel
//         in ThemesClient) must stop the poll loop instead of leaking
//         it across to whatever happens next.
//   M5 -- two submits before the first POST resolves must send
//         exactly one `fetch` call.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeRequestForm } from "../../components/themes/ThemeRequestForm";
import * as dataThemes from "../../lib/data-themes";

// API_BASE must be truthy for the component to take the POST path
// instead of the degraded (GitHub Issue) one -- lib/config.ts re-
// exports it from @paperpilot/core/site as a build-time constant, so
// it's mocked here rather than set via env.
vi.mock("../../lib/config", () => ({ API_BASE: "https://api.example.test" }));

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
    // before cancel) resolve now, after B has already taken over.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(outcomeMock).toHaveBeenCalledWith("theme-a");
    // The bug this guards: A's "ready" outcome must never call onReady
    // for A's slug once B is the live run.
    expect(onReady).not.toHaveBeenCalledWith("theme-a");
    // B must still be showing its own live, non-failed progress panel
    // (A's loop invalidating itself must not touch B's state).
    screen.getByText(/「Theme B」を生成中/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("unmounting the form stops the poll loop (no post-unmount state updates)", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(queuedResponse("theme-a", REQUEST_ID_A))),
    );
    vi.spyOn(dataThemes, "fetchThemesManifest").mockResolvedValue({ status: "ok", data: [] });
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
    });

    unmount();
    const callsBeforeAdvance = outcomeMock.mock.calls.length;

    // Advance past several poll intervals -- if the loop weren't
    // actually stopped, it would keep calling pollThemeQualityOutcome
    // (manifest is empty so it never reaches that call in this fixture,
    // but React would still warn/error on any setState after unmount
    // if the loop's state-setting callbacks ran).
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(outcomeMock.mock.calls.length).toBe(callsBeforeAdvance);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
