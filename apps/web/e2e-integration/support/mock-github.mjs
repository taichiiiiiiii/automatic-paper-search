#!/usr/bin/env node
/**
 * Mock GitHub for the request-flow integration test. The test-only Worker
 * entry (apps/api/test/integration/worker-entry.ts) rewrites
 *   https://api.github.com/<p>            -> http://127.0.0.1:<port>/api.github.com/<p>
 *   https://raw.githubusercontent.com/<p> -> http://127.0.0.1:<port>/raw/<p>
 * so every GitHub call the Worker makes lands here and is recorded.
 *
 * - GET  /raw/<owner>/<repo>/<ref>/data/published/themes/themes-manifest.json
 *        serves the BUILT site's manifest (apps/web/out), so "exists" answers
 *        follow the published data, unless overridden via /__config.
 * - POST /api.github.com/repos/<o>/<r>/actions/workflows/<file>/dispatches
 *        records {workflow, ref, inputs, authorization} and answers
 *        `dispatchStatus` (default 204, GitHub's real answer).
 * Control (used by the tests only):
 * - POST /__reset   clears the log and the config
 * - POST /__config  merges {dispatchStatus, manifestStatus, manifest, delayMs}
 * - GET  /__calls   {dispatches: [...], manifestReads: n, other: [...]}
 *
 * Usage: node mock-github.mjs [--port 4290]. Dependency-free.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const i = process.argv.indexOf("--port");
const PORT = Number(i >= 0 ? process.argv[i + 1] : (process.env.MOCK_GITHUB_PORT ?? 4290));
const MANIFEST_FILE = join(HERE, "..", "..", "out", "themes", "themes-manifest.json");

const DEFAULT_CONFIG = {
  dispatchStatus: 204,
  manifestStatus: 200,
  manifest: null,
  delayMs: 0,
};
let config = { ...DEFAULT_CONFIG };
let calls = { dispatches: [], manifestReads: 0, other: [] };

function builtManifest() {
  return existsSync(MANIFEST_FILE) ? JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) : [];
}

function send(res, status, body, type = "application/json") {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, text ? { "content-type": type } : {});
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const DISPATCH_RE =
  /^\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/;
const MANIFEST_RE =
  /^\/raw\/([^/]+)\/([^/]+)\/([^/]+)\/data\/published\/themes\/themes-manifest\.json$/;

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const body = await readBody(req);
  if (url.pathname === "/__reset" && req.method === "POST") {
    config = { ...DEFAULT_CONFIG };
    calls = { dispatches: [], manifestReads: 0, other: [] };
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/__config" && req.method === "POST") {
    config = { ...config, ...JSON.parse(body || "{}") };
    return send(res, 200, { ok: true, config });
  }
  if (url.pathname === "/__calls" && req.method === "GET") {
    return send(res, 200, calls);
  }
  if (config.delayMs > 0) await new Promise((r) => setTimeout(r, config.delayMs));

  const manifest = MANIFEST_RE.exec(url.pathname);
  if (manifest && req.method === "GET") {
    calls.manifestReads += 1;
    if (config.manifestStatus !== 200)
      return send(res, config.manifestStatus, "upstream error", "text/plain");
    return send(res, 200, config.manifest ?? builtManifest());
  }
  const dispatch = DISPATCH_RE.exec(url.pathname);
  if (dispatch && req.method === "POST") {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { unparsable: body };
    }
    calls.dispatches.push({
      owner: dispatch[1],
      repo: dispatch[2],
      workflow: decodeURIComponent(dispatch[3]),
      ref: parsed?.ref,
      inputs: parsed?.inputs,
      authorization: req.headers.authorization ?? null,
      apiVersion: req.headers["x-github-api-version"] ?? null,
      status: config.dispatchStatus,
    });
    if (config.dispatchStatus === 204) return send(res, 204);
    if (config.dispatchStatus === 401) return send(res, 401, { message: "Bad credentials" });
    return send(res, config.dispatchStatus, { message: "Server Error" });
  }
  calls.other.push(`${req.method} ${url.pathname}`);
  return send(res, 404, { message: "Not Found" });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`mock github on http://127.0.0.1:${PORT}`);
});
