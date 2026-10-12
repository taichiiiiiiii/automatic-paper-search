// Contract: every workflow_dispatch the Worker sends must match the
// target workflow's `on.workflow_dispatch.inputs` (names, required, type /
// choice options) and pass the workflow's own input validation, so the
// Worker and .github/workflows cannot drift apart silently (a dispatch with
// an unknown input is rejected by GitHub with 422; a missing required input
// too — both would only show up in production as a 502 for every visitor).
//
// The payloads are captured from the REAL code paths (the POST
// /api/themes handler and the watchdog's runScheduled), not re-typed here.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { THEME_INPUT_PATTERN } from "../src/lib/slug.js";
import { createThemesPostHandler } from "../src/routes/themes.js";
import type { Env } from "../src/types.js";
import { runScheduled } from "../src/watchdog/scheduled.js";
import { parseJsonc } from "./helpers/jsonc.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOWS = join(REPO, ".github", "workflows");

interface DispatchInput {
  required?: boolean;
  type?: string;
  default?: unknown;
  options?: string[];
}

function dispatchInputs(file: string): Record<string, DispatchInput> {
  const doc = parse(readFileSync(join(WORKFLOWS, file), "utf8"));
  const on = doc.on ?? doc[true as unknown as string]; // YAML 1.1 `on` -> true
  expect(on, `${file} has an on: block`).toBeTruthy();
  expect(Object.keys(on), `${file} accepts workflow_dispatch`).toContain("workflow_dispatch");
  return (on.workflow_dispatch?.inputs ?? {}) as Record<string, DispatchInput>;
}

/** GitHub's own acceptance rules for a dispatch `inputs` object. */
function expectInputsAccepted(file: string, inputs: Record<string, unknown>): void {
  const declared = dispatchInputs(file);
  for (const [name, value] of Object.entries(inputs)) {
    const spec = declared[name];
    expect(spec, `${file}: input "${name}" is not declared (GitHub answers 422)`).toBeDefined();
    // The REST API takes every input as a string (max 10 top-level keys).
    expect(typeof value, `${file}: input "${name}" must be sent as a string`).toBe("string");
    const type = spec!.type ?? "string";
    if (type === "choice") expect(spec!.options, `${file}: ${name} options`).toContain(value);
    if (type === "boolean") expect(["true", "false"]).toContain(value);
    if (type === "number") expect(Number.isFinite(Number(value))).toBe(true);
  }
  expect(Object.keys(inputs).length).toBeLessThanOrEqual(10);
  for (const [name, spec] of Object.entries(declared)) {
    if (spec.required && spec.default === undefined) {
      expect(inputs, `${file}: required input "${name}" is missing`).toHaveProperty(name);
    }
  }
}

function captureFetch(handler: (url: string, init?: RequestInit) => Response | undefined) {
  const dispatches: Array<{ workflow: string; ref: string; inputs: Record<string, unknown> }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = /\/actions\/workflows\/([^/]+)\/dispatches$/.exec(url);
    if (m && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      dispatches.push({ workflow: decodeURIComponent(m[1]!), ref: body.ref, inputs: body.inputs });
      return new Response(null, { status: 204 });
    }
    return handler(url, init) ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, dispatches };
}

const production = parseJsonc(
  readFileSync(join(REPO, "apps", "api", "wrangler.jsonc"), "utf8"),
) as { vars: Record<string, string> };

describe("POST /api/themes -> theme-on-demand.yml", () => {
  const workflowFile = production.vars.GH_WORKFLOW_FILE!;

  async function dispatchFor(theme: string) {
    const { impl, dispatches } = captureFetch((url) =>
      url.startsWith("https://raw.githubusercontent.com/") ? new Response("[]") : undefined,
    );
    const handler = createThemesPostHandler({
      fetch: impl,
      quota: () => ({ consume: async () => ({ allowed: true }), refund: async () => {} }),
      log: () => {},
    });
    const env: Env = {
      ...(production.vars as unknown as Env),
      GH_DISPATCH_PAT: "pat",
      CONFIG_KV: {
        get: async (k: string) =>
          k === "origin_allowlist" ? '["https://site.test"]' : k === "accepting" ? "true" : null,
      },
    };
    const resp = await handler(
      new Request("https://w.test/api/themes", {
        method: "POST",
        headers: {
          origin: "https://site.test",
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.1",
        },
        body: JSON.stringify({ theme }),
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(dispatches).toHaveLength(1);
    return dispatches[0]!;
  }

  it("targets the configured workflow file, which exists and is dispatchable", async () => {
    const d = await dispatchFor("Vision Transformer");
    expect(d.workflow).toBe(workflowFile);
    expect(readdirSync(WORKFLOWS)).toContain(workflowFile);
    expect(d.ref).toBe(production.vars.GH_REF);
  });

  it("sends exactly the declared inputs, as strings, incl. every required one", async () => {
    const d = await dispatchFor("Vision Transformer");
    expect(Object.keys(d.inputs).sort()).toEqual(["request_id", "theme"]);
    expectInputsAccepted(workflowFile, d.inputs);
    const declared = dispatchInputs(workflowFile);
    expect(declared.theme).toMatchObject({ required: true, type: "string" });
    expect(declared.request_id).toMatchObject({ type: "string" });
  });

  it("every value the Worker accepts passes the workflow's own input validation", async () => {
    const text = readFileSync(join(WORKFLOWS, workflowFile), "utf8");
    const doc = parse(text);
    const validate = (
      doc.jobs.generate.steps as Array<{ name?: string; env?: Record<string, string> }>
    ).find((s) => s.env?.THEME_RE && s.env?.REQUEST_ID_RE);
    expect(validate, "theme-on-demand.yml keeps its 'Validate input early' step").toBeDefined();
    const themeRe = new RegExp(validate!.env!.THEME_RE!);
    const requestIdRe = new RegExp(validate!.env!.REQUEST_ID_RE!);
    // Boundaries of the shared pattern: the Worker must never accept what
    // the workflow then rejects (a run that fails at step 1 after the
    // visitor was told "queued").
    for (const theme of ["ab", "Vision Transformer", "a_b-c 9", "x".repeat(80), "  padded  "]) {
      if (!THEME_INPUT_PATTERN.test(theme.trim())) continue;
      const d = await dispatchFor(theme);
      expect(String(d.inputs.theme)).toMatch(themeRe);
      expect(String(d.inputs.request_id)).toMatch(requestIdRe);
    }
    for (const rejected of ["a", "x".repeat(81), "ab/cd", "日本語", "a\nb"]) {
      expect(THEME_INPUT_PATTERN.test(rejected), rejected).toBe(themeRe.test(rejected));
    }
  });
});

describe("watchdog cron -> alert.yml / conference-watch.yml / theme-feeds.yml", () => {
  it("every dispatch of a Monday run with problems matches its workflow", async () => {
    const { impl, dispatches } = captureFetch(() => new Response("down", { status: 503 }));
    const kv = { get: async () => null, put: async () => {} };
    const monday = Date.parse("2026-10-12T00:30:00Z");
    expect(new Date(monday).getUTCDay()).toBe(1);
    await runScheduled(
      {
        ...(production.vars as unknown as Env),
        GH_DISPATCH_PAT: "pat",
        CONFIG_KV: { get: async () => null },
      },
      monday,
      { fetch: impl, kv, log: () => {}, siteOrigin: "https://site.test" },
    );
    const files = dispatches.map((d) => d.workflow).sort();
    expect(files).toEqual(["alert.yml", "conference-watch.yml", "theme-feeds.yml"]);
    for (const d of dispatches) {
      expect(readdirSync(WORKFLOWS)).toContain(d.workflow);
      expect(d.ref).toBe(production.vars.GH_REF);
      expectInputsAccepted(d.workflow, d.inputs);
    }
  });
});

describe("no Worker source names a workflow that is missing or not dispatchable", () => {
  it("every *.yml mentioned in apps/api/src exists with workflow_dispatch", () => {
    const srcDir = join(REPO, "apps", "api", "src");
    const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".ts"),
    );
    const named = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(join(srcDir, f), "utf8").matchAll(/"([a-z0-9-]+\.yml)"/g)) {
        named.add(m[1]!);
      }
    }
    named.add(production.vars.GH_WORKFLOW_FILE!);
    expect(named.size).toBeGreaterThanOrEqual(4);
    for (const file of named) dispatchInputs(file);
  });
});
