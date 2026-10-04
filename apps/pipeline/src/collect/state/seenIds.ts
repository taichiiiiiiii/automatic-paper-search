/**
 * Deduplication and incremental "seen IDs" tracking — TS port of
 * `paperpilot/utils/dedup.py` (COL-19..22, COL-34 of
 * docs/migration/safety-contracts.md).
 *
 * seen_ids.json format (v2.0, unchanged): `{ "<paper.uid>": "<timestamp>",
 * ... }` (absolute rule §8). Old IDs are purged after `maxAgeDays`. The
 * timestamp VALUE is written in Python's naive (no-tzinfo) local
 * `datetime.now().isoformat()` shape, not `Date.toISOString()` — this
 * state file is inherited across the Python->TS cutover (both runtimes
 * read/write the SAME file over time), so a value-format change here
 * would mix two shapes in one file. See {@link pyNaiveIsoformat} (write)
 * and {@link parseSeenIdsTimestamp} (read) below.
 *
 * ## Locking (COL-22): lockfile + O_EXCL instead of `flock`
 *
 * Python holds an exclusive `fcntl.flock` on a sibling `<path>.lock` file
 * descriptor for the whole read-merge-write of {@link mergeSeenIds}. Node's
 * `node:fs` exposes no `flock` syscall, so this port uses a different
 * mechanism with an equivalent *outcome* (serialized read-merge-write
 * across concurrent callers), not the same *primitive*:
 *
 *   - "holding the lock" = having successfully created `<path>.lock` with
 *     the `wx` flag (open, fail with EEXIST if it already exists — the
 *     same O_EXCL semantics `NamedTemporaryFile` relies on elsewhere in
 *     this port).
 *   - "releasing the lock" = deleting that file.
 *   - A caller that finds the lock file already there polls (short sleep,
 *     retry) until it can create it, OR until the lock is judged STALE: if
 *     the existing lock file's mtime is older than {@link STALE_LOCK_MS}
 *     (a previous holder almost certainly crashed without cleaning up —
 *     this pipeline's own run never holds the lock longer than one
 *     JSON read+merge+write), the stale file is removed and the attempt
 *     retried immediately.
 *   - Unlike a blocking `flock`, this polls with a bounded overall timeout
 *     ({@link LOCK_ACQUIRE_TIMEOUT_MS}) and throws rather than hanging
 *     forever — acceptable for this pipeline-internal, single-host state
 *     file; documented as an intentional behavior difference, not a parity
 *     gap the ported tests need to hide.
 */

import { randomBytes } from "node:crypto";
// Imported as a namespace (not destructured) so a test can
// `vi.mock("node:fs", ...)` + `vi.spyOn(fs, "renameSync")` etc to simulate
// a failure partway through, mirroring Python's
// `monkeypatch.setattr(dedup_mod.os, "replace", ...)`.
import * as fs from "node:fs";
import { dirname } from "node:path";
import type { Paper } from "../model/paper.js";
import { paperUid } from "../model/paper.js";

// ---------------------------------------------------------------------
// dedup (pure)
// ---------------------------------------------------------------------

/**
 * Remove duplicates by uid (preserving first occurrence), then run a
 * second, additive pass that merges records sharing a strong
 * arxiv-id/DOI alias even though their primary `uid` differs (COL-34).
 * Never touches `arxivId`/`doi`/`url` on the kept representative, and
 * never changes how `uid` is derived.
 */
export function dedupPapers(papers: readonly Paper[]): Paper[] {
  const seen = new Set<string>();
  const unique: Paper[] = [];
  for (const p of papers) {
    const uid = paperUid(p);
    if (seen.has(uid)) continue;
    seen.add(uid);
    unique.push(p);
  }
  return mergeAliasDuplicates(unique);
}

/**
 * Union-find over (arxivId, doi) aliases; keeps the first-seen paper per
 * group, backfilling only abstract/pdfUrl/authors from later group members
 * when the kept paper's own value is empty. A whitespace-only alias never
 * indexes (would falsely link two otherwise-unrelated blank-alias papers).
 */
function mergeAliasDuplicates(papers: readonly Paper[]): Paper[] {
  const parent = papers.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number;
      i = parent[i] as number;
    }
    return i;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) {
      const hi = Math.max(ri, rj);
      const lo = Math.min(ri, rj);
      parent[hi] = lo;
    }
  };

  const byArxiv = new Map<string, number>();
  const byDoi = new Map<string, number>();
  papers.forEach((p, i) => {
    if (p.arxivId) {
      const key = p.arxivId.trim().toLowerCase();
      if (key) {
        if (byArxiv.has(key)) union(i, byArxiv.get(key) as number);
        else byArxiv.set(key, i);
      }
    }
    if (p.doi) {
      const key = p.doi.trim().toLowerCase();
      if (key) {
        if (byDoi.has(key)) union(i, byDoi.get(key) as number);
        else byDoi.set(key, i);
      }
    }
  });

  const groups = new Map<number, number[]>();
  for (let i = 0; i < papers.length; i++) {
    const root = find(i);
    const arr = groups.get(root);
    if (arr) arr.push(i);
    else groups.set(root, [i]);
  }

  const result: Paper[] = [];
  for (const indices of groups.values()) {
    const rep = papers[indices[0] as number] as Paper;
    for (const idx of indices.slice(1)) {
      const dup = papers[idx] as Paper;
      if (!rep.abstract && dup.abstract) rep.abstract = dup.abstract;
      if (!rep.pdfUrl && dup.pdfUrl) rep.pdfUrl = dup.pdfUrl;
      if (rep.authors.length === 0 && dup.authors.length > 0) rep.authors = dup.authors;
    }
    result.push(rep);
  }
  return result;
}

export function filterUnseen(
  papers: readonly Paper[],
  seen: Readonly<Record<string, string>>,
): Paper[] {
  return papers.filter((p) => !(paperUid(p) in seen));
}

export function markSeen(
  papers: readonly Paper[],
  seen: Record<string, string>,
  now: () => Date = () => new Date(),
): Record<string, string> {
  const nowIso = pyNaiveIsoformat(now());
  for (const p of papers) seen[paperUid(p)] = nowIso;
  return seen;
}

export function purgeSeenIds(
  seen: Readonly<Record<string, string>>,
  maxAgeDays: number,
  now: () => Date = () => new Date(),
): Record<string, string> {
  const cutoff = now().getTime() - maxAgeDays * 86_400_000;
  const kept: Record<string, string> = {};
  for (const [uid, ts] of Object.entries(seen)) {
    const parsed = parseSeenIdsTimestamp(ts);
    // Mirrors Python's `except ValueError: continue` in purge_seen_ids —
    // an unparseable entry is dropped, not kept indefinitely.
    if (parsed !== null && parsed > cutoff) kept[uid] = ts;
  }
  return kept;
}

// ---------------------------------------------------------------------
// load / quarantine (COL-19)
// ---------------------------------------------------------------------

export interface LoadSeenIdsOptions {
  /** Out-param: one note per file moved aside (mirrors Python's keyword-only `quarantine_notes`). */
  quarantineNotes?: string[];
  now?: () => Date;
  logger?: { warn: (msg: string) => void };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * `datetime.now().isoformat()` for a NAIVE (no-tzinfo) local datetime —
 * the exact shape `dedup.py`'s `mark_seen`/`load_seen_ids` (legacy list
 * branch) write into `seen_ids.json` VALUES (absolute rule §8: `{id:
 * timestamp}`). This is deliberately NOT `@paperpilot/core/pycompat`'s
 * `pyIsoformat` — that one is for a tz-AWARE UTC datetime and always
 * appends `+00:00`; seen_ids timestamps carry no offset at all, matching
 * the real committed files (`paperpilot/data/seen_ids*.json`, e.g.
 * `"2026-05-24T10:27:25.069350"` — checked directly, every entry in both
 * committed files has this exact shape: no `Z`, no `+HH:MM`, always a
 * 6-digit fraction).
 *
 * Python omits the `.ffffff` fractional part entirely when
 * `microsecond == 0` — mirrored here. JS `Date` only has millisecond
 * resolution, so the fractional part this produces is always a multiple
 * of 1000 microseconds (e.g. `.069000`, never `.069350`) — an inherent
 * precision-limit difference, not a bug: seen_ids timestamps are metadata
 * the purge comparison reads at day granularity (`max_age_days`), never
 * an identity field. Under a whole-second injected clock (`ms === 0`,
 * e.g. `e2e.test.ts`'s fixed clock) this produces a BYTE-IDENTICAL string
 * to Python's.
 */
function pyNaiveIsoformat(d: Date): string {
  const text =
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const ms = d.getMilliseconds();
  if (ms === 0) return text;
  return `${text}.${pad(ms * 1000, 6)}`;
}

/**
 * Parses a `seen_ids.json` timestamp VALUE back to epoch milliseconds, or
 * `null` if unparseable — mirrors Python's `datetime.fromisoformat`
 * raising `ValueError` on garbage, which `purge_seen_ids` catches and
 * drops (see {@link purgeSeenIds}). Two shapes are accepted, both read as
 * a LOCAL wall-clock instant (never converted through UTC, matching
 * naive-datetime semantics):
 *
 *   1. Python's naive isoformat (`YYYY-MM-DDTHH:MM:SS[.ffffff]`, no
 *      offset) — the only shape either committed `seen_ids*.json` file
 *      has ever been observed to contain, and what {@link
 *      pyNaiveIsoformat} (this module's own writer) now produces.
 *   2. Defensively, anything else `Date.parse` accepts (a trailing `Z`,
 *      a `+HH:MM` offset, etc) — e.g. a file written by an EARLIER build
 *      of this TS port (before this fix) that used `Date.toISOString()`,
 *      so an upgrade does not quarantine or lose a pre-existing file.
 */
function parseSeenIdsTimestamp(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6]);
    const frac = m[7];
    const ms = frac ? Math.round(Number(frac.padEnd(6, "0").slice(0, 6)) / 1000) : 0;
    const date = new Date(year, month - 1, day, hour, minute, second, ms);
    // `new Date(...)` silently NORMALIZES an out-of-range field (e.g. day
    // 32 rolls into next month) instead of raising, unlike Python's
    // constructor — reject anything that didn't round-trip exactly, so a
    // garbage string is dropped (closer to Python's ValueError), not
    // misread as some nearby valid date.
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day ||
      date.getHours() !== hour ||
      date.getMinutes() !== minute ||
      date.getSeconds() !== second
    ) {
      return null;
    }
    return date.getTime();
  }
  const fallback = Date.parse(value);
  return Number.isNaN(fallback) ? null : fallback;
}

function utcStamp(d: Date): string {
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/**
 * Move an existing-but-unreadable seen-ids file aside (`.corrupt-<UTC
 * stamp>`, never overwriting an earlier quarantine), logging a WARNING
 * (the event must not be swallowed silently) and return the note a caller
 * hands to an operator. If the move itself fails, returns a note that says
 * so instead of naming a file that was never created.
 */
function quarantineUnreadable(
  path: string,
  reason: string,
  now: () => Date,
  logger?: { warn: (msg: string) => void },
): string {
  const stamp = utcStamp(now());
  let target = `${path}.corrupt-${stamp}`;
  let attempt = 1;
  while (fs.existsSync(target)) {
    target = `${path}.corrupt-${stamp}.${attempt}`;
    attempt += 1;
  }
  try {
    fs.renameSync(path, target);
  } catch (moveError) {
    logger?.warn(
      `seen_ids: ${path} is ${reason} and could not be moved aside (${(moveError as Error).message}); ` +
        "the next save will overwrite it. Every paper it listed will be re-sent this run.",
    );
    return `unreadable file could not be moved aside to ${target} (${(moveError as Error).message})`;
  }
  logger?.warn(
    `seen_ids: ${path} is ${reason}; moved it aside to ${target}. Treating it as empty means every ` +
      "paper it listed looks unseen again, so recover the entries by hand before the next save if " +
      "re-sending them is not acceptable.",
  );
  return `unreadable file quarantined to ${target}`;
}

/**
 * Read the seen-ids map. A MISSING file means "nothing seen yet" (`{}`,
 * silent). An EXISTING but unreadable file (corrupt JSON, not-UTF-8 bytes,
 * wrong JSON shape, or an fs error such as "is a directory") is quarantined
 * (moved aside) rather than silently treated as empty, because that would
 * make every paper it listed look unseen again and re-send the backlog.
 */
export function loadSeenIds(
  path: string,
  options: LoadSeenIdsOptions = {},
): Record<string, string> {
  const now = options.now ?? (() => new Date());
  if (!fs.existsSync(path)) return {};

  let buf: Buffer;
  try {
    buf = fs.readFileSync(path);
  } catch (e) {
    const note = quarantineUnreadable(
      path,
      `unreadable (${(e as Error).message})`,
      now,
      options.logger,
    );
    options.quarantineNotes?.push(note);
    return {};
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    const note = quarantineUnreadable(path, "unreadable (not UTF-8)", now, options.logger);
    options.quarantineNotes?.push(note);
    return {};
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const note = quarantineUnreadable(
      path,
      `unreadable (${(e as Error).message})`,
      now,
      options.logger,
    );
    options.quarantineNotes?.push(note);
    return {};
  }

  if (Array.isArray(data)) {
    // Legacy list format.
    const nowIso = pyNaiveIsoformat(now());
    const out: Record<string, string> = {};
    for (const uid of data) out[String(uid)] = nowIso;
    return out;
  }
  if (typeof data !== "object" || data === null) {
    const note = quarantineUnreadable(
      path,
      `not a JSON object (got ${typeof data})`,
      now,
      options.logger,
    );
    options.quarantineNotes?.push(note);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (!k) continue;
    out[k] = String(v);
  }
  return out;
}

// ---------------------------------------------------------------------
// save (its own atomic write — deliberately NOT `state/atomic.ts`; see
// module doc for why there are two atomic writers in this port, mirroring
// the Python original having two as well)
// ---------------------------------------------------------------------

function writeFileAtomicNoChmod(path: string, text: string): void {
  const dir = dirname(path);
  fs.mkdirSync(dir, { recursive: true });
  let tmpPath: string | null = null;
  let fd: number | null = null;
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = `${dir}/.${path.split("/").pop()}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        fd = fs.openSync(candidate, "wx");
        tmpPath = candidate;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
    }
    if (fd === null || tmpPath === null) {
      throw new Error(`could not create a unique temp file next to ${path}`);
    }
    fs.writeSync(fd, Buffer.from(text, "utf-8"));
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, path);
    tmpPath = null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    if (tmpPath !== null) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/**
 * Atomically overwrite seen_ids.json. Last-writer-wins by design; a run
 * must use {@link mergeSeenIds} instead, which does the read-merge-write
 * under the lock.
 */
export function saveSeenIds(path: string, seen: Readonly<Record<string, string>>): void {
  writeFileAtomicNoChmod(path, JSON.stringify(seen, null, 2));
}

// ---------------------------------------------------------------------
// merge under lock (COL-22)
// ---------------------------------------------------------------------

const STALE_LOCK_MS = 60_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Acquires the sibling `<path>.lock` (see module doc for the O_EXCL scheme). */
async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* another caller may have already cleared it; retry the loop */
        }
        continue;
      }
    } catch {
      // Lock file vanished between our failed create and this stat; retry.
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for lock ${lockPath}`);
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already released */
  }
}

/**
 * Mark `papers` seen in the on-disk file and return the merged mapping. The
 * whole read-merge-write runs while holding the lock (see module doc), so
 * two runs that each loaded the same snapshot and mark disjoint papers do
 * not last-writer-wins each other's contribution. The disk copy is
 * re-read INSIDE the lock, the new IDs are stamped on top, and the purge is
 * re-applied to the merged result so aged-out entries are not resurrected
 * by a stale in-memory copy.
 */
export async function mergeSeenIds(
  path: string,
  papers: readonly Paper[],
  options: { maxAgeDays: number; now?: () => Date },
): Promise<Record<string, string>> {
  const now = options.now ?? (() => new Date());
  fs.mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  await acquireLock(lockPath);
  try {
    let merged = loadSeenIds(path);
    merged = markSeen(papers, merged, now);
    merged = purgeSeenIds(merged, options.maxAgeDays, now);
    saveSeenIds(path, merged);
    return merged;
  } finally {
    releaseLock(lockPath);
  }
}
