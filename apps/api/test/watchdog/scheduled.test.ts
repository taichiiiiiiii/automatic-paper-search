// R1-6: unit tests for the Worker cron watchdog (src/watchdog/*) with a
// mocked fetch. No network, no real KV.

import { describe, expect, it } from "vitest";
import type { Env } from "../../src/types.js";
import {
  checkPublishedThemes,
  checkWorkflows,
  countPublishedThemes,
  parseTokenExpiration,
  patExpiryProblems,
} from "../../src/watchdog/checks.js";
import {
  ALERT_WORKFLOW_FILE,
  CONFERENCE_WATCH_WORKFLOW_FILE,
  decideAlert,
  EMPTY_STATE,
  KV_KEY_WATCHDOG_STATE,
  parseState,
  REMINDER_INTERVAL_MS,
  runScheduled,
  THEME_FEEDS_DAYS,
  THEME_FEEDS_WORKFLOW_FILE,
  type WatchdogKv,
} from "../../src/watchdog/scheduled.js";

const SITE = "https://site.test";
const PAT = "github_pat_SECRET123";
// 2026-10-12 is a Monday; 2026-10-13 a Tuesday.
const MONDAY = Date.parse("2026-10-12T00:30:00Z");
const TUESDAY = Date.parse("2026-10-13T00:30:00Z");

function memKv(init: Record<string, string> = {}): WatchdogKv & { store: Record<string, string> } {
  const store = { ...init };
  return {
    store,
    async get(key) {
      return key in store ? store[key]! : null;
    },
    async put(key, value) {
      store[key] = value;
    },
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GH_OWNER: "o",
    GH_REPO: "r",
    GH_WORKFLOW_FILE: "theme-on-demand.yml",
    GH_REF: "develop",
    DISPATCH_MODE: "live",
    GH_DISPATCH_PAT: PAT,
    CONFIG_KV: { get: async (k: string) => (k === "accepting" ? "true" : null) },
    ...overrides,
  };
}

function quality(themes: number) {
  const rows = [
    { kind: "conference", availability: "ready", publication_tier: "blocked" },
    { kind: "theme", availability: "ready", publication_tier: "blocked" },
  ];
  for (let i = 0; i < themes; i++) {
    rows.push({
      kind: "theme",
      availability: "ready",
      publication_tier: i % 2 ? "audited" : "unaudited",
    });
  }
  return { schema_version: "lineage-quality-v1", collections: rows };
}

interface Call {
  url: string;
  init?: RequestInit;
}

interface Scenario {
  pageStatus?: Record<string, number>;
  themes?: number;
  runs?: Record<string, { status: string; conclusion: string | null; id: number } | 404>;
  ghStatus?: number;
  expiration?: string | null;
  pending?: unknown;
  dispatchStatus?: number;
}

function mockFetch(s: Scenario = {}) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/dispatches")) {
      return new Response(
        s.dispatchStatus === undefined || s.dispatchStatus === 204 ? null : `bad ${PAT}`,
        {
          status: s.dispatchStatus ?? 204,
        },
      );
    }
    if (url.startsWith("https://api.github.com/")) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const exp = s.expiration === undefined ? "2027-01-07 00:00:00 UTC" : s.expiration;
      if (exp) headers["github-authentication-token-expiration"] = exp;
      if (s.ghStatus) return new Response("{}", { status: s.ghStatus, headers });
      const wf = url.match(/workflows\/([^/]+)\/runs/)?.[1] ?? "";
      const run = s.runs?.[wf];
      if (run === 404) return new Response("{}", { status: 404, headers });
      const runs = run
        ? [
            {
              ...run,
              html_url: `https://github.com/o/r/actions/runs/${run.id}`,
              created_at: "2026-10-11T00:00:00Z",
            },
          ]
        : [{ id: 1, status: "completed", conclusion: "success" }];
      return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200, headers });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      return s.pending === undefined
        ? new Response("404", { status: 404 })
        : new Response(JSON.stringify(s.pending), { status: 200 });
    }
    if (url === `${SITE}/lineage-quality-v1.json`) {
      return new Response(JSON.stringify(quality(s.themes ?? 4)), { status: 200 });
    }
    const status = s.pageStatus?.[url] ?? 200;
    return new Response("ok", { status });
  };
  return { fn, calls };
}

function dispatches(calls: Call[]) {
  return calls
    .filter((c) => c.url.endsWith("/dispatches"))
    .map((c) => ({
      workflow: c.url.match(/workflows\/([^/]+)\/dispatches/)?.[1],
      body: JSON.parse(String(c.init?.body)) as { ref: string; inputs: Record<string, string> },
      auth: (c.init?.headers as Record<string, string> | undefined)?.authorization,
    }));
}

async function run(
  s: Scenario,
  opts: { kv?: ReturnType<typeof memKv>; at?: number; env?: Partial<Env> } = {},
) {
  const kv = opts.kv ?? memKv();
  const f = mockFetch(s);
  const logs: string[] = [];
  const at = opts.at ?? TUESDAY;
  const result = await runScheduled(makeEnv(opts.env), at, {
    fetch: f.fn,
    kv,
    siteOrigin: SITE,
    now: () => new Date(at),
    log: (m) => logs.push(m),
  });
  return { result, calls: f.calls, kv, logs };
}

describe("parseTokenExpiration", () => {
  it("parses the UTC and numeric-offset forms GitHub sends", () => {
    expect(parseTokenExpiration("2027-01-07 00:00:00 UTC")?.toISOString()).toBe(
      "2027-01-07T00:00:00.000Z",
    );
    expect(parseTokenExpiration("2027-01-07 09:00:00 +0900")?.toISOString()).toBe(
      "2027-01-07T00:00:00.000Z",
    );
  });
  it("returns null for absent or garbage values", () => {
    expect(parseTokenExpiration(null)).toBeNull();
    expect(parseTokenExpiration("soon")).toBeNull();
  });
});

describe("patExpiryProblems", () => {
  const exp = new Date("2027-01-07T00:00:00Z");
  it("is quiet 14+ days before expiry", () => {
    expect(patExpiryProblems(exp, new Date("2026-12-24T00:00:00Z"))).toEqual([]);
  });
  it("warns inside 14 days and escalates (new key) inside 3 days", () => {
    const warn = patExpiryProblems(exp, new Date("2026-12-25T00:00:00Z"));
    expect(warn).toHaveLength(1);
    expect(warn[0]!.key).toBe("pat:expiry:2027-01-07:warn");
    expect(warn[0]!.message).toContain("あと 13 日");
    const urgent = patExpiryProblems(exp, new Date("2027-01-05T00:00:00Z"));
    expect(urgent[0]!.key).toBe("pat:expiry:2027-01-07:urgent");
  });
  it("is quiet for a non-expiring token (no header)", () => {
    expect(patExpiryProblems(null, new Date())).toEqual([]);
  });
});

describe("countPublishedThemes / checkPublishedThemes", () => {
  it("counts only ready themes with a public tier", () => {
    expect(countPublishedThemes(quality(3))).toBe(3);
    expect(() => countPublishedThemes({})).toThrow();
  });
  it("flags 0 themes and a drop against the stored baseline", async () => {
    const zero = await checkPublishedThemes(mockFetch({ themes: 0 }).fn, SITE, null);
    expect(zero.problems.map((p) => p.key)).toEqual(["themes:none"]);
    const drop = await checkPublishedThemes(mockFetch({ themes: 3 }).fn, SITE, 4);
    expect(drop.problems.map((p) => p.key)).toEqual(["themes:drop:4->3"]);
    expect(drop.count).toBe(3);
    const same = await checkPublishedThemes(mockFetch({ themes: 5 }).fn, SITE, 4);
    expect(same.problems).toEqual([]);
  });
});

describe("checkWorkflows", () => {
  const env = makeEnv();
  it("reports a failed latest develop run with its run id in the key", async () => {
    const { fn, calls } = mockFetch({
      runs: { "tests.yml": { status: "completed", conclusion: "failure", id: 77 } },
    });
    const r = await checkWorkflows(fn, env, ["tests.yml", "pages.yml"]);
    expect(r.problems.map((p) => p.key)).toEqual(["workflow:tests.yml:77"]);
    expect(calls[0]!.url).toContain("branch=develop");
    expect((calls[0]!.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      `Bearer ${PAT}`,
    );
    expect(r.patExpiresAt?.toISOString()).toBe("2027-01-07T00:00:00.000Z");
  });
  it("ignores in-progress runs, skipped runs and workflows not on the ref (404)", async () => {
    const { fn } = mockFetch({
      runs: {
        "a.yml": { status: "in_progress", conclusion: null, id: 1 },
        "b.yml": { status: "completed", conclusion: "skipped", id: 2 },
        "c.yml": 404,
      },
    });
    expect((await checkWorkflows(fn, env, ["a.yml", "b.yml", "c.yml"])).problems).toEqual([]);
  });
  it("reports an invalid/expired PAT once, not per workflow", async () => {
    const { fn } = mockFetch({ ghStatus: 401 });
    const r = await checkWorkflows(fn, env, ["a.yml", "b.yml"]);
    expect(r.problems.map((p) => p.key)).toEqual(["github:auth:401"]);
  });
});

describe("decideAlert", () => {
  const p = [{ key: "a", message: "A" }];
  const now = new Date(TUESDAY);
  it("does nothing when healthy and nothing is open", () => {
    expect(decideAlert([], EMPTY_STATE, now)).toEqual({ action: "none" });
  });
  it("alerts on a new problem set, stays quiet on the same set, reminds after 7 days", () => {
    expect(decideAlert(p, EMPTY_STATE, now)).toEqual({ action: "problem", reason: "new" });
    const recent = {
      ...EMPTY_STATE,
      alerted_fingerprint: "a",
      alerted_at: new Date(TUESDAY - 86_400_000).toISOString(),
    };
    expect(decideAlert(p, recent, now)).toEqual({ action: "none" });
    const old = { ...recent, alerted_at: new Date(TUESDAY - REMINDER_INTERVAL_MS).toISOString() };
    expect(decideAlert(p, old, now)).toEqual({ action: "problem", reason: "reminder" });
  });
  it("resolves when healthy again after an alert", () => {
    expect(decideAlert([], { ...EMPTY_STATE, alerted_fingerprint: "a" }, now)).toEqual({
      action: "resolved",
    });
  });
});

describe("parseState", () => {
  it("falls back to the empty state on missing or corrupt JSON", () => {
    expect(parseState(null)).toEqual(EMPTY_STATE);
    expect(parseState("{nope")).toEqual(EMPTY_STATE);
  });
});

describe("runScheduled", () => {
  it("healthy Tuesday: no dispatch at all, baseline stored", async () => {
    const { result, calls, kv } = await run({});
    expect(result.problems).toEqual([]);
    expect(dispatches(calls)).toEqual([]);
    const state = JSON.parse(kv.store[KV_KEY_WATCHDOG_STATE]!);
    expect(state.published_themes).toBe(4);
    expect(state.alerted_fingerprint).toBe("");
    // checks the three site pages and the legacy redirect page
    for (const p of ["/", "/themes/", "/how-it-works/"]) {
      expect(calls.some((c) => c.url === `${SITE}${p}`)).toBe(true);
    }
  });

  it("dispatches conference-watch.yml and theme-feeds.yml on Mondays only", async () => {
    const mon = await run({}, { at: MONDAY });
    expect(dispatches(mon.calls).map((d) => d.workflow)).toEqual([
      CONFERENCE_WATCH_WORKFLOW_FILE,
      THEME_FEEDS_WORKFLOW_FILE,
    ]);
    expect(dispatches(mon.calls)[0]!.body.ref).toBe("develop");
    expect(dispatches(mon.calls)[1]!.body.inputs).toEqual({ days: THEME_FEEDS_DAYS });
    expect(mon.result.conferenceWatchDispatched).toBe(true);
    expect(mon.result.themeFeedsDispatched).toBe(true);
  });

  it("a page failure dispatches alert.yml once with status=problem; the next run with the same problem is silent", async () => {
    const kv = memKv();
    const s: Scenario = { pageStatus: { [`${SITE}/themes/`]: 503 } };
    const first = await run(s, { kv });
    const d = dispatches(first.calls);
    expect(d).toHaveLength(1);
    expect(d[0]!.workflow).toBe(ALERT_WORKFLOW_FILE);
    expect(d[0]!.auth).toBe(`Bearer ${PAT}`);
    expect(d[0]!.body.ref).toBe("develop");
    expect(d[0]!.body.inputs.status).toBe("problem");
    expect(d[0]!.body.inputs.summary).toContain(`${SITE}/themes/ が 503`);
    expect(d[0]!.body.inputs.summary).not.toContain(PAT);

    const second = await run(s, { kv, at: TUESDAY + 86_400_000 });
    expect(dispatches(second.calls)).toEqual([]);

    const healed = await run({}, { kv, at: TUESDAY + 2 * 86_400_000 });
    const r = dispatches(healed.calls);
    expect(r).toHaveLength(1);
    expect(r[0]!.body.inputs.status).toBe("resolved");
    expect(JSON.parse(kv.store[KV_KEY_WATCHDOG_STATE]!).alerted_fingerprint).toBe("");
  });

  it("a changed problem set re-alerts and marks the new item", async () => {
    const kv = memKv();
    await run({ pageStatus: { [`${SITE}/`]: 500 } }, { kv });
    const next = await run(
      {
        pageStatus: { [`${SITE}/`]: 500 },
        runs: { "pages.yml": { status: "completed", conclusion: "failure", id: 9 } },
      },
      { kv, at: TUESDAY + 3_600_000 },
    );
    const summary = dispatches(next.calls)[0]!.body.inputs.summary;
    expect(summary).toContain("🆕 pages.yml");
    expect(summary).not.toContain(`🆕 ${SITE}/ が`);
  });

  it("alerts on the PAT expiring within 14 days", async () => {
    const at = Date.parse("2026-12-30T00:30:00Z"); // Wednesday, 8 days before 2027-01-07
    const { result, calls } = await run({}, { at });
    expect(result.problems.map((p) => p.key)).toEqual(["pat:expiry:2027-01-07:warn"]);
    expect(dispatches(calls)[0]!.body.inputs.summary).toContain(
      "wrangler secret put GH_DISPATCH_PAT",
    );
  });

  it("alerts on a published-theme drop against the KV baseline", async () => {
    const kv = memKv({
      [KV_KEY_WATCHDOG_STATE]: JSON.stringify({ ...EMPTY_STATE, published_themes: 6 }),
    });
    const { result } = await run({ themes: 4 }, { kv });
    expect(result.problems.map((p) => p.key)).toEqual(["themes:drop:6->4"]);
    expect(JSON.parse(kv.store[KV_KEY_WATCHDOG_STATE]!).published_themes).toBe(4);
  });

  it("reports /api/health problems from the in-process handler", async () => {
    const { result } = await run(
      {},
      { env: { GH_DISPATCH_PAT: PAT, CONFIG_KV: { get: async () => null } } },
    );
    expect(result.problems.map((p) => p.key)).toEqual(["health:accepting"]);
  });

  it("reports regen-pending themes stuck past the retry cap", async () => {
    const { result } = await run({
      pending: {
        themes: [
          { theme: "GNN", attempts: 5, reason: "llm_quota" },
          { theme: "OK", attempts: 1, reason: "llm_quota" },
        ],
      },
    });
    expect(result.problems.map((p) => p.key)).toEqual(["regen-pending:GNN"]);
  });

  it("keeps the alert pending (state not advanced) when the dispatch fails, and redacts the PAT in logs", async () => {
    const kv = memKv();
    const { result, logs } = await run(
      { pageStatus: { [`${SITE}/`]: 500 }, dispatchStatus: 403 },
      { kv },
    );
    expect(result.alertDispatched).toBe(false);
    expect(JSON.parse(kv.store[KV_KEY_WATCHDOG_STATE]!).alerted_fingerprint).toBe("");
    expect(logs.join("\n")).toContain("alert dispatch failed: 403");
    expect(logs.join("\n")).not.toContain(PAT);
  });

  it("a non-live (preview / dry-run) Worker checks but never dispatches", async () => {
    const { result, calls } = await run(
      { pageStatus: { [`${SITE}/`]: 500 } },
      { at: MONDAY, env: { DISPATCH_MODE: "dry-run" } },
    );
    expect(result.problems.map((p) => p.key)).toContain(`page:${SITE}/`);
    expect(dispatches(calls)).toEqual([]);
  });

  it("never throws when every fetch rejects", async () => {
    const kv = memKv();
    const result = await runScheduled(makeEnv(), TUESDAY, {
      fetch: async () => {
        throw new Error("network down");
      },
      kv,
      siteOrigin: SITE,
      log: () => undefined,
    });
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.alertDispatched).toBe(false);
  });
});
