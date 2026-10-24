// R2-47: the status route and the in-flight dedup read the matching
// workflow run, so a failed / cancelled run is shown to the page and no
// longer swallows a re-submission.

import { beforeEach, describe, expect, it } from "vitest";
import { InflightLedger } from "../../src/lib/inflight.js";
import type { QuotaBackend } from "../../src/lib/quota.js";
import { clearRunStatusCache, lookupRun, runEndedBadly } from "../../src/lib/run-status.js";
import { createThemeStatusHandler, createThemesPostHandler } from "../../src/routes/themes.js";
import type { Env } from "../../src/types.js";

const ORIGIN = "https://paperpilot.pages.dev";
const OLD_ID = "theme-11111111-1111-4111-8111-111111111111";
const NEW_ID = "theme-22222222-2222-4222-8222-222222222222";

function run(conclusion: string | null, status = "completed", id = OLD_ID) {
  return {
    status,
    conclusion,
    html_url: "https://github.com/o/r/actions/runs/1",
    created_at: "2026-10-24T00:00:00Z",
    run_started_at: "2026-10-24T00:00:01Z",
    display_title: `theme-on-demand: Diffusion Models / ${id}`,
  };
}

function makeEnv(pat: string | undefined = "pat"): Env {
  return {
    GH_OWNER: "o",
    GH_REPO: "r",
    GH_WORKFLOW_FILE: "theme-on-demand.yml",
    GH_REF: "develop",
    GH_DISPATCH_PAT: pat,
    DISPATCH_MODE: "live",
    CONFIG_KV: {
      async get(key: string) {
        if (key === "origin_allowlist") return JSON.stringify([ORIGIN]);
        if (key === "accepting") return "true";
        return null;
      },
    },
  };
}

function fakeGithub(runs: unknown[] | "fail") {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.startsWith("https://raw.githubusercontent.com")) return new Response("[]");
    if (url.includes("/dispatches")) return new Response(null, { status: 204 });
    if (runs === "fail") return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => clearRunStatusCache());

describe("lookupRun / runEndedBadly", () => {
  it("picks the run whose title ends with the request id and projects a public shape", async () => {
    const gh = fakeGithub([run("success", "completed", NEW_ID), run("failure")]);
    const got = await lookupRun(OLD_ID, makeEnv(), { fetch: gh.fetchImpl });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.run?.conclusion).toBe("failure");
      expect(Object.keys(got.run ?? {}).sort()).toEqual(
        [
          "conclusion",
          "created_at",
          "display_title",
          "html_url",
          "run_started_at",
          "status",
        ].sort(),
      );
    }
  });

  it("caches per request id for the TTL (one GitHub call for repeated polls)", async () => {
    const gh = fakeGithub([run("failure")]);
    let t = 1_000;
    const deps = { fetch: gh.fetchImpl, now: () => t };
    await lookupRun(OLD_ID, makeEnv(), deps);
    t += 5_000;
    await lookupRun(OLD_ID, makeEnv(), deps);
    expect(gh.calls.length).toBe(1);
    t += 20_000;
    await lookupRun(OLD_ID, makeEnv(), deps);
    expect(gh.calls.length).toBe(2);
  });

  it("fails soft: no PAT, bad id, or a GitHub error is not an answer", async () => {
    const gh = fakeGithub("fail");
    expect((await lookupRun(OLD_ID, makeEnv(undefined), { fetch: gh.fetchImpl })).ok).toBe(false);
    expect((await lookupRun("nope", makeEnv(), { fetch: gh.fetchImpl })).ok).toBe(false);
    expect((await lookupRun(OLD_ID, makeEnv(), { fetch: gh.fetchImpl })).ok).toBe(false);
  });

  it("only a completed run that did not succeed counts as ended badly", () => {
    expect(runEndedBadly(null)).toBe(false);
    expect(runEndedBadly(run(null, "in_progress"))).toBe(false);
    expect(runEndedBadly(run("success"))).toBe(false);
    for (const c of ["failure", "cancelled", "timed_out"]) expect(runEndedBadly(run(c))).toBe(true);
  });
});

describe("GET /api/themes/status (live)", () => {
  const req = (id: string) =>
    new Request(`https://w.test/api/themes/status?request_id=${id}`, {
      headers: { origin: ORIGIN },
    });

  it("returns the run, with CORS", async () => {
    const gh = fakeGithub([run("cancelled")]);
    const res = await createThemeStatusHandler({ fetch: gh.fetchImpl })(req(OLD_ID), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = (await res.json()) as { run: { conclusion: string } };
    expect(body.run.conclusion).toBe("cancelled");
  });

  it("400 for a malformed id, 503 when GitHub cannot be asked", async () => {
    const handler = createThemeStatusHandler({ fetch: fakeGithub("fail").fetchImpl });
    expect((await handler(req("not-an-id"), makeEnv())).status).toBe(400);
    expect((await handler(req(OLD_ID), makeEnv())).status).toBe(503);
  });
});

describe("POST dedup after a dead run", () => {
  function setup(runs: unknown[] | "fail") {
    const gh = fakeGithub(runs);
    const ledger = new InflightLedger(
      (() => {
        const map = new Map<string, unknown>();
        return {
          async get<T>(k: string) {
            return map.get(k) as T | undefined;
          },
          async put(k: string, v: unknown) {
            map.set(k, v);
          },
          async delete(k: string) {
            return map.delete(k);
          },
        };
      })(),
      () => 0,
    );
    const quota: QuotaBackend = {
      async consume() {
        return { allowed: true };
      },
      async refund() {},
    };
    const handler = createThemesPostHandler({
      fetch: gh.fetchImpl,
      quota: () => quota,
      inflight: () => ledger,
      randomUUID: () => NEW_ID.slice("theme-".length),
      log: () => {},
    });
    const post = async () => {
      const res = await handler(
        new Request("https://w.test/api/themes", {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            "cf-connecting-ip": "1.2.3.4",
          },
          body: JSON.stringify({ theme: "Diffusion Models" }),
        }),
        makeEnv(),
      );
      return (await res.json()) as Record<string, unknown>;
    };
    return { gh, ledger, post };
  }

  it("dispatches again when the in-flight run failed", async () => {
    const { gh, ledger, post } = setup([run("failure")]);
    await ledger.claim("diffusion-models", OLD_ID);
    const body = await post();
    expect(body.status).toBe("queued");
    expect(body.deduplicated).toBeUndefined();
    expect(body.request_id).toBe(NEW_ID);
    expect(gh.calls.some((c) => c.url.includes("/dispatches"))).toBe(true);
    expect(await ledger.peek("diffusion-models")).toBe(NEW_ID);
  });

  for (const [name, runs] of [
    ["still running", [run(null, "in_progress")]],
    ["succeeded", [run("success")]],
    ["not found", []],
    ["GitHub unreachable", "fail"],
  ] as const) {
    it(`still follows the old run when it is ${name}`, async () => {
      const { gh, ledger, post } = setup(runs as unknown[] | "fail");
      await ledger.claim("diffusion-models", OLD_ID);
      const body = await post();
      expect(body.deduplicated).toBe(true);
      expect(body.request_id).toBe(OLD_ID);
      expect(gh.calls.some((c) => c.url.includes("/dispatches"))).toBe(false);
    });
  }
});
