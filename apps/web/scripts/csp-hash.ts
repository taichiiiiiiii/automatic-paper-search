#!/usr/bin/env -S npx tsx
/**
 * Post-build CSP injector.
 *
 * Walks apps/web/out/**\/*.html, computes the sha256 of each inline
 * <script> body (exact bytes between the tags, excluding any <script
 * src="...">), and writes/replaces a single
 * <meta http-equiv="Content-Security-Policy"> tag per page.
 *
 * All directives except script-src are byte-identical across every page
 * (see docs/design/39-typescript-cloudflare-migration.md §4.4). Only
 * script-src varies, carrying that page's inline-script hashes.
 *
 * Also writes out/_headers containing only `frame-ancestors 'self'`
 * (frame-ancestors has no effect in a meta CSP, so it must ship as an
 * HTTP header instead; it is kept out of the meta tag's own directives
 * to avoid two CSPs disagreeing).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCspContent } from "../lib/config";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPT_DIR, "..", "out");

const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
const META_CSP_RE = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i;

async function listHtmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listHtmlFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(full);
    }
  }
  return files;
}

function sha256Base64(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("base64");
}

/** Hashes of every inline (no src=) <script> body found in the page, in order. */
function collectInlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(SCRIPT_TAG_RE)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    if (/\bsrc\s*=/.test(attrs)) continue; // external script: not hashed, not inline
    hashes.push(`'sha256-${sha256Base64(body)}'`);
  }
  return hashes;
}

/** This page's full CSP content: site-wide directives (from
 * @paperpilot/core, via lib/config) plus this page's own script-src. */
function cspContentFor(scriptHashes: string[]): string {
  const scriptSrc = `script-src 'self'${scriptHashes.length ? ` ${scriptHashes.join(" ")}` : ""}`;
  return buildCspContent(scriptSrc);
}

function upsertMetaCsp(html: string, content: string): string {
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${content}">`;
  if (META_CSP_RE.test(html)) {
    return html.replace(META_CSP_RE, metaTag);
  }
  if (!html.includes("<head>")) {
    throw new Error("expected a literal <head> tag to inject CSP meta after");
  }
  return html.replace("<head>", `<head>${metaTag}`);
}

async function main(): Promise<void> {
  const files = await listHtmlFiles(OUT_DIR);
  if (files.length === 0) {
    throw new Error(`no .html files found under ${OUT_DIR}; run next build first`);
  }
  for (const file of files.sort()) {
    const html = await readFile(file, "utf8");
    const hashes = collectInlineScriptHashes(html);
    const cspContent = cspContentFor(hashes);
    const updated = upsertMetaCsp(html, cspContent);
    await writeFile(file, updated, "utf8");
    console.log(`csp-hash: ${relative(OUT_DIR, file)} -> ${hashes.length} inline script hash(es)`);
  }
  await writeFile(join(OUT_DIR, "_headers"), `frame-ancestors 'self'\n`, "utf8");
  console.log(`csp-hash: wrote ${join(OUT_DIR, "_headers")}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
