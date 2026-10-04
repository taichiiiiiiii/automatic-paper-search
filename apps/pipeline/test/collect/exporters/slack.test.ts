/**
 * Port of the Slack-exporter cases of `paperpilot/tests/test_exporters.py`.
 */
import { expect, it } from "vitest";
import { SlackExporter } from "../../../src/collect/exporters/slack.js";
import type { FetchLike, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";

function samplePapers(): Paper[] {
  return [
    createPaper({
      title: "T1",
      authors: ["A"],
      abstract: "abs",
      url: "http://x/1",
      publishedDate: "2026-04-10",
      source: "arxiv",
      arxivId: "2604.001",
      totalScore: 100.0,
    }),
    createPaper({
      title: "T2",
      authors: ["B", "C"],
      abstract: "abs2",
      url: "http://x/2",
      publishedDate: "2026-04-10",
      source: "s2",
      arxivId: "2604.002",
      totalScore: 50.0,
    }),
  ];
}

function okResp(): HttpResponseLike {
  return { status: 200, json: async () => ({}) };
}

interface Captured {
  body?: { text: string };
}

function captureFetch(resp: HttpResponseLike, captured: Captured): FetchLike {
  return async (_url, init) => {
    captured.body = JSON.parse(init.body as string);
    return resp;
  };
}

it("test_slack_no_webhook_is_noop", async () => {
  const exp = new SlackExporter(
    { enabled: true },
    { fetchImpl: async () => okResp(), webhookUrl: null },
  );
  expect(await exp.export(samplePapers())).toBeNull();
});

it("test_slack_posts_formatted_message", async () => {
  const captured: Captured = {};
  const exp = new SlackExporter(
    { enabled: true },
    { fetchImpl: captureFetch(okResp(), captured), webhookUrl: "http://hook" },
  );
  const result = await exp.export(samplePapers());
  expect(result).toBe("slack");
  expect(captured.body?.text).toContain("PaperPilot");
  expect(captured.body?.text).toContain("T1");
  expect(captured.body?.text).toContain("T2");
});

it("test_slack_handles_failure", async () => {
  const exp = new SlackExporter(
    { enabled: true },
    {
      fetchImpl: async () => ({ status: 500, json: async () => ({}) }),
      webhookUrl: "http://hook",
      sleep: async () => {},
    },
  );
  await expect(exp.export(samplePapers())).rejects.toThrow("slack post failed");
});

it("test_slack_respects_max_items", async () => {
  const papers = Array.from({ length: 10 }, () => samplePapers()).flat();
  const captured: Captured = {};
  const exp = new SlackExporter(
    { enabled: true, max_items: 3 },
    { fetchImpl: captureFetch(okResp(), captured), webhookUrl: "http://hook" },
  );
  await exp.export(papers);
  const body = captured.body?.text ?? "";
  expect((body.match(/\n1\. /g) ?? []).length).toBe(1);
  expect((body.match(/\n2\. /g) ?? []).length).toBe(1);
  expect((body.match(/\n3\. /g) ?? []).length).toBe(1);
  expect((body.match(/\n4\. /g) ?? []).length).toBe(0);
});

it("test_slack_reports_the_count_it_actually_delivered", async () => {
  const papers = Array.from({ length: 10 }, () => samplePapers()).flat();
  const exp = new SlackExporter(
    { enabled: true, max_items: 3 },
    { fetchImpl: async () => okResp(), webhookUrl: "http://hook" },
  );
  expect(await exp.export(papers)).toBe("slack");
  expect(exp.lastDelivered).toBe(3);
});

it("test_slack_never_reports_a_delivery_that_did_not_happen", async () => {
  const papers = samplePapers();
  const exp = new SlackExporter(
    { enabled: true, max_items: 1 },
    { fetchImpl: async () => okResp(), webhookUrl: "http://hook" },
  );
  await exp.export(papers);
  expect(exp.lastDelivered).toBe(1);

  const expBad = new SlackExporter(
    { enabled: true, max_items: 1 },
    {
      fetchImpl: async () => ({ status: 500, json: async () => ({}) }),
      webhookUrl: "http://hook",
      sleep: async () => {},
    },
  );
  await expect(expBad.export(papers)).rejects.toThrow("slack post failed");
  expect(expBad.lastDelivered).toBe(0);

  const unconfigured = new SlackExporter(
    { enabled: true },
    { fetchImpl: async () => okResp(), webhookUrl: null },
  );
  expect(await unconfigured.export(papers)).toBeNull();
  expect(unconfigured.lastDelivered).toBe(0);
});

it("test_slack_escapes_mrkdwn_special_chars_in_title_and_venue", async () => {
  const malicious = [
    createPaper({
      title: "A <malicious|link> & <https://evil.example|click here>",
      authors: ["A"],
      abstract: "abs",
      url: "http://x/1?a=1&b=2",
      publishedDate: "2026-04-10",
      source: "arxiv",
      arxivId: "2604.001",
      totalScore: 100.0,
      venue: "<Fake Venue>",
    }),
  ];
  const captured: Captured = {};
  const exp = new SlackExporter(
    { enabled: true },
    { fetchImpl: captureFetch(okResp(), captured), webhookUrl: "http://hook" },
  );
  await exp.export(malicious);
  const body = captured.body?.text ?? "";
  expect(body).not.toContain("<malicious|link>");
  expect(body).not.toContain("<https://evil.example|click here>");
  expect(body).not.toContain("<Fake Venue>");
  expect(body).toContain("&lt;malicious|link&gt;");
  expect(body).toContain("&lt;Fake Venue&gt;");
  expect(body).toContain("&amp;");
});

it("test_slack_url_control_sequence_injection_is_neutralized", async () => {
  const maliciousUrls = ["!here", "@U0123456789", "#C0123456789", "javascript:alert(1)"];
  const papers = maliciousUrls.map((u, i) =>
    createPaper({
      title: `Paper ${i}`,
      authors: ["A"],
      abstract: "abs",
      url: u,
      publishedDate: "2026-04-10",
      source: "arxiv",
      arxivId: `2604.00${i}`,
      totalScore: 100.0,
    }),
  );
  const captured: Captured = {};
  const exp = new SlackExporter(
    { enabled: true },
    { fetchImpl: captureFetch(okResp(), captured), webhookUrl: "http://hook" },
  );
  await exp.export(papers);
  const body = captured.body?.text ?? "";
  for (const u of maliciousUrls) expect(body).not.toContain(`<${u}|`);
  for (let i = 0; i < maliciousUrls.length; i++) expect(body).toContain(`Paper ${i}`);
});

it("formats the header with the LOCAL calendar date, not the UTC date (collect LOW: clock, non-noon case)", async () => {
  // Pacific/Kiritimati is UTC+14: a local instant shortly after local
  // midnight is still the PREVIOUS day in UTC. `process.env.TZ` is set
  // explicitly for this test only, so it is deterministic regardless of
  // the host/CI's own default timezone.
  const originalTz = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";
  try {
    const localToday = new Date(2026, 3, 10, 2, 0, 0); // 2026-04-10T02:00 local
    expect(localToday.toISOString().slice(0, 10)).toBe("2026-04-09"); // UTC day is the 9th
    const captured: Captured = {};
    const exp = new SlackExporter(
      { enabled: true },
      {
        fetchImpl: captureFetch(okResp(), captured),
        webhookUrl: "http://hook",
        today: () => localToday,
      },
    );
    await exp.export(samplePapers());
    expect(captured.body?.text).toContain("2026-04-10");
    expect(captured.body?.text).not.toContain("2026-04-09");
  } finally {
    process.env.TZ = originalTz;
  }
});

it("test_slack_legitimate_https_url_still_renders_as_link", async () => {
  const papers = [
    createPaper({
      title: "Legit Paper",
      authors: ["A"],
      abstract: "abs",
      url: "https://arxiv.org/abs/2604.00001",
      publishedDate: "2026-04-10",
      source: "arxiv",
      arxivId: "2604.00001",
      totalScore: 100.0,
    }),
  ];
  const captured: Captured = {};
  const exp = new SlackExporter(
    { enabled: true },
    { fetchImpl: captureFetch(okResp(), captured), webhookUrl: "http://hook" },
  );
  await exp.export(papers);
  expect(captured.body?.text).toContain("<https://arxiv.org/abs/2604.00001|Legit Paper>");
});
