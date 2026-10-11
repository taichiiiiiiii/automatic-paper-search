import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PaperLinksSourcePaper } from "./logic";

/**
 * Reads `public/<conf>/papers.json` with `node:fs` at build time for the
 * no-JS paper-links routes (`page.tsx` = page 1, `[page]/page.tsx` =
 * pages 2..n). See page.tsx's doc comment for why this is not
 * `lib/data.ts`'s runtime `fetchConferencePapers`.
 */
export function readPapers(conf: string): PaperLinksSourcePaper[] {
  const path = join(process.cwd(), "public", conf, "papers.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // A static export has no server to 404 this at request time: fail the
    // build loudly instead of rendering Next's not-found fallback as a
    // 200-status static page (the bug this replaces -- see build-guard.ts,
    // which should already keep this route from being generated at all;
    // this throw is the last-resort backstop if that guard is ever
    // bypassed).
    throw new Error(`${conf}/papers.json is missing; cannot render /${conf}/paper-links/`, {
      cause: err,
    });
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${conf}/papers.json: expected an array`);
  }
  return parsed as PaperLinksSourcePaper[];
}
