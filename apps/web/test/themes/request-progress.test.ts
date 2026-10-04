// Port of paperpilot/tests/viewer/test_theme_request_progress.mjs onto
// lib/themes-request.ts's exported pure functions (no VM/source-text
// extraction needed here -- these are plain TS exports).
import { describe, expect, it } from "vitest";
import {
  failureFromRun,
  PROGRESS_STEP_LABELS,
  PROGRESS_STEPS,
  progressPercentFor,
  REQUEST_ID_RE,
  safeRunUrl,
  statusUrlForRequest,
} from "../../lib/themes-request";

describe("PROGRESS_STEPS contract", () => {
  it('is an array with at least 3 entries including "ready"', () => {
    expect(Array.isArray(PROGRESS_STEPS)).toBe(true);
    expect(PROGRESS_STEPS.length).toBeGreaterThanOrEqual(3);
    expect(PROGRESS_STEPS).toContain("ready");
  });

  it("PROGRESS_STEP_LABELS has exactly one label per step, in the same order (anti PR-#229-drift guard)", () => {
    expect(Object.keys(PROGRESS_STEP_LABELS)).toEqual([...PROGRESS_STEPS]);
    for (const step of PROGRESS_STEPS) {
      expect(typeof PROGRESS_STEP_LABELS[step]).toBe("string");
      expect(PROGRESS_STEP_LABELS[step].length).toBeGreaterThan(0);
    }
  });
});

describe("progressPercentFor", () => {
  it("dispatch is at 0%", () => {
    expect(progressPercentFor("dispatch")).toBe(0);
  });

  it("ready is at 100%", () => {
    expect(progressPercentFor("ready")).toBe(100);
  });

  it("queue is strictly between 0 and 100", () => {
    const v = progressPercentFor("queue");
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(100);
  });

  it("percent increases monotonically across PROGRESS_STEPS", () => {
    for (let i = 1; i < PROGRESS_STEPS.length; i++) {
      const prev = progressPercentFor(PROGRESS_STEPS[i - 1]!);
      const cur = progressPercentFor(PROGRESS_STEPS[i]!);
      expect(cur).toBeGreaterThan(prev);
    }
  });

  it("an unknown step falls back to 0% (defensive)", () => {
    expect(progressPercentFor("unknown-step")).toBe(0);
  });
});

describe("request ID polling", () => {
  const requestId = "theme-123e4567-e89b-42d3-a456-426614174000";

  it("accepts the generated request ID format", () => {
    expect(REQUEST_ID_RE.test(requestId)).toBe(true);
  });

  it("builds the status URL from request_id and normalises a trailing slash", () => {
    expect(statusUrlForRequest("https://worker.example/", requestId)).toBe(
      `https://worker.example/api/themes/status?request_id=${requestId}`,
    );
  });

  it("a malformed request ID cannot trigger status polling", () => {
    expect(statusUrlForRequest("https://worker.example", "bad")).toBeNull();
  });

  it("a line-terminated request ID cannot trigger status polling", () => {
    expect(statusUrlForRequest("https://worker.example", `${requestId}\n`)).toBeNull();
  });

  it("a missing API base disables status polling", () => {
    expect(statusUrlForRequest("", requestId)).toBeNull();
  });
});

describe("failureFromRun", () => {
  it("null/undefined run -> null", () => {
    expect(failureFromRun(null)).toBeNull();
    expect(failureFromRun(undefined)).toBeNull();
  });

  it("queued / in_progress -> null (still in flight)", () => {
    expect(failureFromRun({ status: "queued" })).toBeNull();
    expect(failureFromRun({ status: "in_progress" })).toBeNull();
  });

  it("completed/success -> null (manifest poll handles success)", () => {
    expect(failureFromRun({ status: "completed", conclusion: "success" })).toBeNull();
  });

  it("failure conclusion -> a failure object with title/message/runUrl", () => {
    const failure = failureFromRun({
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/owner/repo/actions/runs/123",
    });
    expect(failure).not.toBeNull();
    expect(failure?.title.length).toBeGreaterThan(0);
    expect(failure?.message.length).toBeGreaterThan(0);
    expect(failure?.runUrl).toBe("https://github.com/owner/repo/actions/runs/123");
  });

  it("cancelled conclusion with no html_url -> empty-string runUrl (no broken link)", () => {
    const cancelled = failureFromRun({ status: "completed", conclusion: "cancelled" });
    expect(cancelled).not.toBeNull();
    expect(cancelled?.runUrl).toBe("");
  });

  it("timed_out conclusion mentions timeout (i18n smoke)", () => {
    const timedOut = failureFromRun({
      status: "completed",
      conclusion: "timed_out",
      html_url: "https://x/run/9",
    });
    expect(timedOut?.title).toContain("タイムアウト");
  });

  it("unknown conclusion (e.g. neutral) -> null (don't surface fake failures)", () => {
    expect(failureFromRun({ status: "completed", conclusion: "neutral" })).toBeNull();
  });
});

describe("safeRunUrl", () => {
  it("rejects javascript: scheme", () => {
    expect(safeRunUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects http: (non-https) github.com", () => {
    expect(safeRunUrl("http://github.com/owner/repo/actions/runs/1")).toBeNull();
  });

  it("rejects a lookalike path on the wrong host", () => {
    expect(safeRunUrl("https://evil.test/github.com")).toBeNull();
  });

  it("rejects github.com appearing only in the query string", () => {
    expect(safeRunUrl("https://evil.test/?u=github.com")).toBeNull();
  });

  it("rejects github.com as a subdomain prefix of another host", () => {
    expect(safeRunUrl("https://github.com.evil.test/")).toBeNull();
  });

  it("rejects an unparseable string", () => {
    expect(safeRunUrl("not a url")).toBeNull();
  });

  it("rejects empty/null/undefined", () => {
    expect(safeRunUrl("")).toBeNull();
    expect(safeRunUrl(null)).toBeNull();
    expect(safeRunUrl(undefined)).toBeNull();
  });

  it("passes through a valid https://github.com/... run URL unchanged", () => {
    const validRunUrl = "https://github.com/owner/repo/actions/runs/1";
    expect(safeRunUrl(validRunUrl)).toBe(validRunUrl);
  });
});
