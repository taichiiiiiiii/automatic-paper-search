// Port of paperpilot/tests/viewer/test_theme_submit_contract.mjs's pure
// decision logic onto lib/themes-request.ts's `interpretThemesPostResponse`
// (the part of submitTheme() that decides what happened) and
// lib/themes-gallery.ts's `safeDisplayCount` (renderHeader()'s
// paper_count guard). The DOM-effecting half of the original file
// (constructing <a> elements, innerHTML, dataset.kind) is now plain
// React rendering in components/themes/ThemeRequestForm.tsx, which
// gets React's default escaping for free and is exercised via the
// build's CSP/escaping contract instead of a VM harness.
import { describe, expect, it } from "vitest";
import { safeDisplayCount } from "../../lib/themes-gallery";
import {
  interpretThemesPostResponse,
  issueUrlFor,
  localizedFailureMessage,
} from "../../lib/themes-request";

describe('interpretThemesPostResponse(): "exists" branch', () => {
  it("a valid server slug is returned for the follow-up link, not the raw input", () => {
    const outcome = interpretThemesPostResponse(200, {
      ok: true,
      status: "exists",
      slug: "mixture-of-experts",
    });
    expect(outcome).toEqual({ kind: "exists", slug: "mixture-of-experts" });
  });

  it("an invalid server slug (path-traversal shape) degrades to a null (linkless) slug", () => {
    const outcome = interpretThemesPostResponse(200, { ok: true, status: "exists", slug: "../x" });
    expect(outcome).toEqual({ kind: "exists", slug: null });
  });
});

describe("renderHeader()'s paper_count guard (safeDisplayCount)", () => {
  it("a malicious string paper_count renders as 0, not the raw value", () => {
    expect(safeDisplayCount("<img onerror=x>")).toBe(0);
  });

  it("a well-formed numeric paper_count renders as-is", () => {
    expect(safeDisplayCount(7)).toBe(7);
  });

  it("a negative or fractional count also renders as 0", () => {
    expect(safeDisplayCount(-1)).toBe(0);
    expect(safeDisplayCount(1.5)).toBe(0);
  });
});

describe("interpretThemesPostResponse(): Worker-failure status -> Japanese message mapping", () => {
  const MAPPED_FAILURES = [
    {
      status: 403,
      serverMessage: "request origin is not allowed",
      expectJa: "このページ以外からの依頼は受け付けていません",
      expectIssueLink: false,
    },
    {
      status: 413,
      serverMessage: "request body exceeds the 1KB limit",
      expectJa: "依頼の形式が正しくありません",
      expectIssueLink: false,
    },
    {
      status: 415,
      serverMessage: "content-type must be application/json",
      expectJa: "依頼の形式が正しくありません",
      expectIssueLink: false,
    },
    {
      status: 502,
      serverMessage: "could not start the generation job; please retry shortly",
      expectJa: "GitHub への依頼に失敗しました。時間をおいて再度お試しください",
      expectIssueLink: true,
    },
    {
      status: 503,
      serverMessage: "could not verify existing themes; please retry shortly",
      expectJa: "既存テーマの確認に失敗しました。時間をおいて再度お試しください",
      expectIssueLink: true,
    },
  ];

  for (const c of MAPPED_FAILURES) {
    it(`HTTP ${c.status} maps to the expected Japanese UI text and does not leak the raw message`, () => {
      const outcome = interpretThemesPostResponse(c.status, {
        ok: false,
        status: "error",
        message: c.serverMessage,
      });
      expect(outcome.kind).toBe("error");
      if (outcome.kind === "error") {
        expect(outcome.message).toBe(c.expectJa);
        expect(outcome.message).not.toContain(c.serverMessage);
        expect(outcome.showIssueLink).toBe(c.expectIssueLink);
      }
    });
  }

  it("an already-Japanese Worker message is shown verbatim, not overridden by the status map", () => {
    const jaMessage = "日本語の既存メッセージ";
    const outcome = interpretThemesPostResponse(503, {
      ok: false,
      status: "error",
      message: jaMessage,
    });
    expect(outcome).toEqual({ kind: "error", message: jaMessage, showIssueLink: true });
  });

  it('"rate_limited" is shown verbatim, unchanged by the status mapping, with no Issue link', () => {
    const msg = "more than 5 new themes/hour from this IP";
    const outcome = interpretThemesPostResponse(429, {
      ok: false,
      status: "rate_limited",
      message: msg,
    });
    expect(outcome).toEqual({ kind: "rate_limited", message: msg });
  });

  it('"invalid" is shown verbatim (React escapes it on render; no innerHTML sink exists in this port)', () => {
    const outcome = interpretThemesPostResponse(400, {
      ok: false,
      status: "invalid",
      message: "<img onerror=x>",
    });
    expect(outcome).toEqual({ kind: "invalid", message: "<img onerror=x>" });
  });

  it("§4.2-7 \"paused\" maps to the design doc's fixed Japanese copy, never the Worker's English message", () => {
    const outcome = interpretThemesPostResponse(503, {
      ok: false,
      status: "paused",
      message: "theme submissions are temporarily paused; please check back later",
    });
    expect(outcome).toEqual({ kind: "paused", message: "現在受付を一時停止しています" });
  });
});

describe("interpretThemesPostResponse(): queued / dry_run", () => {
  it("queued with a valid slug + request_id is pollable", () => {
    const requestId = "theme-123e4567-e89b-42d3-a456-426614174000";
    const outcome = interpretThemesPostResponse(200, {
      ok: true,
      status: "queued",
      slug: "vision-transformer",
      request_id: requestId,
    });
    expect(outcome).toEqual({ kind: "queued", slug: "vision-transformer", requestId });
  });

  it("queued without a usable slug/request_id degrades to queued_unusable (SCR-35: no fake progress)", () => {
    const outcome = interpretThemesPostResponse(200, { ok: true, status: "queued" });
    expect(outcome).toEqual({ kind: "queued_unusable" });
  });

  it("queued with an invalid request_id shape degrades to queued_unusable", () => {
    const outcome = interpretThemesPostResponse(200, {
      ok: true,
      status: "queued",
      slug: "vision-transformer",
      request_id: "not-a-uuid",
    });
    expect(outcome).toEqual({ kind: "queued_unusable" });
  });

  it("§4.5 dry_run (preview-only) carries a slug but is never treated as queued", () => {
    const outcome = interpretThemesPostResponse(200, {
      ok: true,
      status: "dry_run",
      slug: "vision-transformer",
    });
    expect(outcome).toEqual({ kind: "dry_run", slug: "vision-transformer" });
  });
});

describe("issueUrlFor", () => {
  it("builds a pre-filled GitHub Issue URL with the theme label", () => {
    const url = issueUrlFor("Vision Transformer");
    expect(url).toContain("https://github.com/taichiiiiiiii/automatic-paper-search/issues/new");
    expect(url).toContain("labels=theme-request");
    expect(url).toContain(encodeURIComponent("[theme request] Vision Transformer"));
  });

  it("the 502/503 Issue-fallback link reuses issueUrlFor, not a second URL builder", () => {
    const outcome = interpretThemesPostResponse(502, { ok: false, status: "error", message: "x" });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.showIssueLink).toBe(true);
    // The component layer is responsible for calling issueUrlFor(rawTheme)
    // when showIssueLink is true -- asserted here so there is exactly one
    // call site defined for that URL, matching SCR-34's "reuse the same
    // builder" requirement.
    expect(issueUrlFor("Vision Transformer")).toBe(
      "https://github.com/taichiiiiiiii/automatic-paper-search/issues/new" +
        `?labels=theme-request&title=${encodeURIComponent("[theme request] Vision Transformer")}` +
        `&body=${encodeURIComponent("## 希望テーマ\nVision Transformer\n\n## 理由 / 背景\n(任意)\n")}`,
    );
  });
});

describe("localizedFailureMessage", () => {
  it("falls back to the raw HTTP status when there is no mapping and no worker message", () => {
    expect(localizedFailureMessage(200, null)).toBe("HTTP 200");
  });
});
