/**
 * Register a new conference's display copy — TS port of
 * `paperpilot/scripts/scaffold_conference_page.py`, redesigned for the new
 * site (docs/design/39-typescript-cloudflare-migration.md §6).
 *
 * ## Why this looks nothing like the Python module
 *
 * `scaffold_conference_page.py` existed because the OLD site is static
 * HTML: every conference needed its own copy of `docs/<conf>/index.html`
 * (cloned from the `cvpr-2026` template, with `--display`/`--lede`
 * substituted in) plus an empty `docs/<conf>/lineage.json` stub so the
 * viewer's optional lineage probe resolved 200 instead of 404.
 *
 * In the new Next.js site (already built — see `apps/web/app/[conf]/`)
 * neither of those exists:
 *
 * - There is exactly ONE page component, `apps/web/app/[conf]/page.tsx`.
 *   Its `generateStaticParams` enumerates conferences straight from
 *   `conferences.json` (`selectCatalogConferences`), and
 *   `assertConferenceHasPapersJson` fails the *build* loudly if a listed
 *   conference's `papers.json` is missing. Both `conferences.json` and
 *   `<conf>/papers.json` are produced by `build_pages`/`build_summary_csv`
 *   (ported elsewhere in this migration) once a collector has run for the
 *   new slug — nothing in THIS module needs to touch either file: a
 *   conference becomes a live catalog route automatically the first time
 *   those two already-ported steps run for it.
 * - There is no per-conference HTML template to clone or substitute text
 *   into, so there is nothing for a hostile `--display`/`--lede` to inject
 *   HTML markup INTO (CNF-21's original concern). The display copy is
 *   consumed as plain data by a React component, which escapes it for free.
 * - `apps/web/lib/catalog-copy.ts`'s `getCatalogCopy()` already has a
 *   graceful fallback for a conference with no entry in its static
 *   `CATALOG_COPY` map (slug-derived generic text, empty lede/tagline) —
 *   so a brand-new conference renders correctly with ZERO manual steps.
 *   There is therefore no hard "page is broken until scaffolded" failure
 *   mode left to guard against; this module is an operator convenience
 *   for getting good copy in quickly, not a release gate.
 * - The empty `lineage.json` stub is obsolete too:
 *   `apps/web/app/[conf]/lineage/route-eligibility.ts`'s
 *   `lineageDataIsNonStub` already treats a missing/empty/malformed
 *   lineage artifact as "no lineage route for this conference" — there is
 *   no 404-vs-200 distinction left for a stub file to paper over.
 *
 * ## What this module actually does
 *
 * Maintains a small JSON manifest, keyed by conference slug, of
 * `{ display, lede }` pairs — the two pieces of free-text operator input
 * `scaffold_conference_page.py --display/--lede` used to take. This is
 * NOT yet wired into `apps/web/lib/catalog-copy.ts` (that file lives
 * outside this task's edit scope, `apps/pipeline/src/conference/**`); at
 * P5 (or whenever that wiring is done), a human or a small script merges
 * each manifest entry into `CATALOG_COPY` once reviewed, or the manifest
 * is read directly by a future version of `getCatalogCopy`. Until that
 * wiring exists, `getCatalogCopy`'s fallback keeps the page honest.
 *
 * `manifestPath` is always caller-supplied (no default under a real repo
 * path): per the migration's data rule (design doc §6.3 / CLAUDE.md "移行中
 * のデータ"), new pipeline code only READS `docs/`/`paperpilot/data/`
 * /`paperpilot/output/`; writes go to a location the caller controls
 * (a temp dir in tests, a real path only once a human wires up a CLI).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { validateConferenceSlug } from "../shared/index.js";

/**
 * Reserved top-level routes/paths a conference slug must never collide
 * with. Union of the new site's reserved catalog routes
 * (`apps/web/lib/catalog-constants.ts::RESERVED_CATALOG_SLUGS` — not
 * imported directly since `apps/web` is outside this task's package
 * graph; kept in sync by hand, same as the Python/Worker/frontend 3-way
 * slug parity CLAUDE.md §14 already requires elsewhere) and the legacy
 * static-site reserved paths `scaffold_conference_page.py` guarded
 * (`assets`, `design`, `how-it-works`, `paper-details-v1`,
 * `paper-slides-v1`, `research`, `search-paper-ids-v1`, `themes`) — several
 * of those no longer correspond to a real route in the new site, but
 * rejecting them too costs nothing and guards against the old `docs/`
 * tree still being served during the migration's co-existence period
 * (design doc §7.3).
 */
export const RESERVED_CONFERENCE_SLUGS: ReadonlySet<string> = new Set([
  // apps/web/lib/catalog-constants.ts RESERVED_CATALOG_SLUGS
  "daily",
  "themes",
  "lineage",
  "how-it-works",
  // legacy docs/ reserved paths (scaffold_conference_page.py)
  "assets",
  "design",
  "paper-details-v1",
  "paper-slides-v1",
  "research",
  "search-paper-ids-v1",
]);

/** Matches a plain multi-line text field: printable Unicode plus `\n`, no C0/C1 control characters (CNF-21's injection defense, reframed for a JSON data field instead of an HTML template). */
function isPlainText(value: string): boolean {
  if (value.trim() === "") return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isNewline = ch === "\n";
    const isControl = (code <= 0x1f && !isNewline) || (code >= 0x7f && code <= 0x9f);
    if (isControl) return false;
  }
  return true;
}

export interface CatalogCopyEntry {
  display: string;
  lede: string;
}

export type CatalogCopyManifest = Record<string, CatalogCopyEntry>;

function readManifest(path: string): CatalogCopyManifest {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  if (raw.trim() === "") return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`catalog-copy manifest at ${path} is not a JSON object`);
  }
  return parsed as CatalogCopyManifest;
}

export class ConferenceAlreadyRegisteredError extends Error {}

/**
 * Register one new conference's display copy in the manifest at
 * `manifestPath`. Refuses an unsafe/reserved slug, refuses to overwrite a
 * slug already present in the manifest (CNF-20's "no overwrite"), and
 * requires `display`/`lede` to be non-empty plain text with no control
 * characters (CNF-21's injection defense carried over). The manifest is
 * rewritten atomically as a whole file (`atomicWriteText`), so a crash
 * mid-write leaves either the old manifest or the new one, never a
 * half-written one (CNF-20's "failure leaves nothing" guarantee, adapted
 * to a single-file manifest instead of two independent files).
 */
export function registerConference(
  conference: string,
  display: string,
  lede: string,
  manifestPath: string,
): CatalogCopyManifest {
  validateConferenceSlug(conference);
  if (RESERVED_CONFERENCE_SLUGS.has(conference)) {
    throw new RangeError(`conference slug ${JSON.stringify(conference)} is a reserved public path`);
  }
  if (!isPlainText(display)) {
    throw new RangeError("display must be non-empty plain text with no control characters");
  }
  if (!isPlainText(lede)) {
    throw new RangeError("lede must be non-empty plain text with no control characters");
  }

  const manifest = readManifest(manifestPath);
  if (conference in manifest) {
    throw new ConferenceAlreadyRegisteredError(
      `refusing to overwrite an existing conference registration: ${conference}`,
    );
  }

  const updated: CatalogCopyManifest = { ...manifest, [conference]: { display, lede } };
  mkdirSync(dirname(manifestPath), { recursive: true });
  atomicWriteText(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}
