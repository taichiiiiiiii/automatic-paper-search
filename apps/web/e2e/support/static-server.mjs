#!/usr/bin/env node
/**
 * Tiny static server for the Playwright suite: serves the Next static
 * export (apps/web/out) the way Cloudflare Pages does, so the browser sees
 * the same URLs, redirects and headers as production.
 *
 * - `_headers`: every rule whose path pattern matches (`*` splat,
 *   `:placeholder` segment) adds its headers; this is how the
 *   `frame-ancestors` CSP header reaches the browser (the per-page meta CSP
 *   is already in the HTML).
 * - `_redirects`: `from to status` rules with `:placeholder` / `*` splats;
 *   the query string is kept.
 * - Trailing slashes (Pages "auto" HTML handling): `/x/` serves
 *   `x/index.html`; `/x` redirects (308) to `/x/` when that directory has an
 *   index.html; `/x.html` and `/x/index.html` redirect to the pretty URL.
 * - Unknown paths return 404 with `404.html` (Pages' non-SPA behaviour).
 *
 * Usage: node static-server.mjs [--root <dir>] [--port <n>]
 * Dependency-free on purpose (runs before/without any build tooling).
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = resolve(arg("root", process.env.E2E_ROOT ?? join(HERE, "..", "..", "out")));
const PORT = Number(arg("port", process.env.E2E_PORT ?? "4173"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".csv": "text/csv; charset=utf-8",
  ".bib": "application/x-bibtex; charset=utf-8",
};

/** Turns a Pages path pattern into a RegExp (`*` = splat, `:x` = one segment). */
function patternToRegExp(pattern) {
  const escaped = pattern
    .split(/(\*|:[A-Za-z_][A-Za-z0-9_]*)/)
    .map((part) => {
      if (part === "*") return "(?<splat>.*)";
      if (part.startsWith(":")) return `(?<${part.slice(1)}>[^/]+)`;
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${escaped}$`);
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/);
}

/** `_headers`: a path line, then indented `Name: value` lines. */
function parseHeaders(file) {
  const rules = [];
  let current = null;
  for (const line of readLines(file)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      const idx = line.indexOf(":");
      if (current && idx > 0) {
        current.headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
      }
    } else {
      current = { re: patternToRegExp(line.trim()), headers: [] };
      rules.push(current);
    }
  }
  return rules;
}

function parseRedirects(file) {
  const rules = [];
  for (const line of readLines(file)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [from, to, status] = t.split(/\s+/);
    if (from && to) rules.push({ re: patternToRegExp(from), to, status: Number(status ?? 302) });
  }
  return rules;
}

const headerRules = parseHeaders(join(ROOT, "_headers"));
const redirectRules = parseRedirects(join(ROOT, "_redirects"));

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function send(res, status, headers, filePath) {
  res.writeHead(status, headers);
  if (filePath) createReadStream(filePath).pipe(res);
  else res.end();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    send(res, 400, {});
    return;
  }
  const headers = {};
  for (const rule of headerRules) {
    if (rule.re.test(pathname)) for (const [k, v] of rule.headers) headers[k] = v;
  }
  headers["Cache-Control"] = "no-store";

  for (const rule of redirectRules) {
    const m = rule.re.exec(pathname);
    if (!m) continue;
    let target = rule.to;
    for (const [k, v] of Object.entries(m.groups ?? {})) {
      target = target.replace(k === "splat" ? ":splat" : `:${k}`, v);
    }
    send(res, rule.status, { ...headers, Location: target + url.search });
    return;
  }

  const fsPath = normalize(join(ROOT, pathname));
  if (fsPath !== ROOT && !fsPath.startsWith(ROOT + sep)) {
    send(res, 403, headers);
    return;
  }

  // Pretty-URL redirects (Pages strips .html and /index.html).
  if (pathname.endsWith("/index.html") && isFile(fsPath)) {
    send(res, 308, { ...headers, Location: pathname.slice(0, -"index.html".length) + url.search });
    return;
  }

  let file = null;
  if (pathname.endsWith("/")) {
    if (isFile(join(fsPath, "index.html"))) file = join(fsPath, "index.html");
  } else if (isFile(fsPath)) {
    file = fsPath;
  } else if (isFile(join(fsPath, "index.html"))) {
    send(res, 308, { ...headers, Location: `${pathname}/${url.search}` });
    return;
  } else if (isFile(`${fsPath}.html`)) {
    file = `${fsPath}.html`;
  }

  if (!file) {
    const notFound = join(ROOT, "404.html");
    send(
      res,
      404,
      { ...headers, "Content-Type": TYPES[".html"] },
      isFile(notFound) ? notFound : null,
    );
    return;
  }
  headers["Content-Type"] = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  if (req.method === "HEAD") {
    send(res, 200, headers);
    return;
  }
  send(res, 200, headers, file);
});

if (!isFile(join(ROOT, "index.html"))) {
  console.error(`static-server: ${ROOT}/index.html not found; build apps/web first`);
  process.exit(1);
}
server.listen(PORT, "127.0.0.1", () => {
  console.log(`static-server: serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
