/**
 * Postbuild step: remove every <script> (and script preloads) from the
 * routes that are meant to work without JavaScript.
 *
 * Why: Next's static export embeds the whole rendered tree a second time
 * as an RSC payload (`self.__next_f.push(...)`) for client-side
 * navigation. `/<conf>/paper-links/` lists every paper of a conference
 * server-side, so that payload doubled the page (cvpr-2026: 4.2MB vs the
 * Python original's 2.1MB; budget 3MB, safety contract CAT-18). Those
 * pages are plain no-JS link lists; their header links still work as
 * ordinary links without hydration.
 *
 * Runs BEFORE csp-hash.ts, so the stripped pages carry no script hashes.
 *
 * Next's static export also writes a plain-text copy of the same RSC
 * payload next to the HTML (`index.txt`, used for client-side
 * navigation prefetch) -- stripping `<script>` tags from the HTML does
 * nothing to that file, so a no-JS route's `index.txt` is deleted
 * outright. It is never fetched by a page the no-JS route itself
 * renders (there is no client-side navigation into or within it), so
 * removing it cannot break anything this route needs.
 */
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "out");

/** Route directories (relative to out/) whose index.html must ship no JS. */
export function isNoJsRoute(relativeDir: string): boolean {
  return /^[a-z0-9-]+\/paper-links$/.test(relativeDir);
}

const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const SCRIPT_PRELOAD_RE =
  /<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*\bas="script"[^>]*\/?>/gi;
const SCRIPT_PRELOAD_RE2 =
  /<link\b[^>]*\bas="script"[^>]*\brel="(?:preload|modulepreload)"[^>]*\/?>/gi;

export function stripScripts(html: string): string {
  return html.replace(SCRIPT_RE, "").replace(SCRIPT_PRELOAD_RE, "").replace(SCRIPT_PRELOAD_RE2, "");
}

async function main(): Promise<void> {
  const top = await readdir(OUT_DIR);
  let stripped = 0;
  for (const conf of top) {
    const rel = `${conf}/paper-links`;
    if (!isNoJsRoute(rel)) continue;
    const file = join(OUT_DIR, rel, "index.html");
    try {
      if (!(await stat(file)).isFile()) continue;
    } catch {
      continue;
    }
    const before = await readFile(file, "utf8");
    const after = stripScripts(before);
    await writeFile(file, after);
    stripped += 1;
    console.log(`strip-nojs: ${rel}/index.html ${before.length} -> ${after.length} bytes`);

    const rscPayload = join(OUT_DIR, rel, "index.txt");
    try {
      await rm(rscPayload);
      console.log(`strip-nojs: removed ${rel}/index.txt`);
    } catch {
      // Not every Next version/route necessarily writes one -- nothing
      // to remove is not an error.
    }
  }
  console.log(`strip-nojs: ${stripped} no-JS page(s)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
