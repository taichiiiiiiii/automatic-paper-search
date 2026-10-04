/**
 * Crash-safe whole-file replacement for published artifacts and caches —
 * TS port of `paperpilot/utils/atomic.py` (OUT-01, OUT-02 of
 * docs/migration/safety-contracts.md).
 *
 * The temporary file is created next to the destination (same filesystem,
 * so `fs.renameSync` is atomic the way `os.replace` is) with a unique name
 * (random suffix via `fs.openSync(..., "wx")`, which fails with EEXIST on a
 * collision — Node's equivalent of Python's O_EXCL-guaranteed
 * `NamedTemporaryFile`). A bare `.tmp` or `.tmp.<pid>` suffix is not unique
 * across concurrent runs or containers that each have their own PID
 * namespace.
 *
 * The destination keeps its existing permission bits (preserved by default
 * on Linux/macOS when reusing an inode's mode is not possible — we read the
 * existing mode and `chmodSync` the temp file to match before renaming); a
 * new file gets 0o644 (what a plain `open(path, "w")` under the usual 022
 * umask produces — a 0o600 temp file would silently narrow a published
 * artifact a web server or sibling process reads).
 *
 * No fsync: this guards against exceptions and process crashes, not power
 * loss — matching the Python module's own documented scope.
 *
 * Last-writer-wins: a caller that merges into shared state must hold its
 * own lock around the read-merge-write (see `state/seenIds.ts`).
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";

// Imported as a namespace (not destructured named imports) so a test can
// `vi.mock("node:fs", ...)` + `vi.spyOn(fs, "renameSync")` to simulate a
// failure partway through — the same seam Python's tests reach via
// `monkeypatch.setattr(atomic_module.os, "replace", ...)`.

const DEFAULT_MODE = 0o644;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function existingMode(path: string): number {
  try {
    return fs.statSync(path).mode & 0o777;
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * `fs.writeSync` is not guaranteed to write the whole buffer in one call
 * (Node's own docs: "It is unsafe to use fs.writeSync() multiple times on
 * the same file without waiting for the callback" is about async/sync
 * interleaving, but the return value — bytes actually written — can be
 * SHORTER than the buffer for the same reasons a raw `write(2)` syscall can
 * be partial). A single unchecked call (M1) silently renames a truncated
 * temp file over the destination on a short write, with no exception to
 * catch it. Loop until every byte is written, mirroring what Python's
 * `file.write()` already guarantees internally.
 */
function writeAll(fd: number, payload: Buffer): void {
  let written = 0;
  while (written < payload.length) {
    written += fs.writeSync(fd, payload, written, payload.length - written);
  }
}

/** Opens a uniquely-named temp file (O_EXCL semantics) next to `destPath`, retrying on collision. */
function openUniqueTemp(destPath: string): { path: string; fd: number } {
  const dir = dirname(destPath);
  const name = basename(destPath);
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = join(dir, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      const fd = fs.openSync(candidate, "wx");
      return { path: candidate, fd };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
  }
  throw new Error(`atomic write: could not create a unique temp file next to ${destPath}`);
}

/** Replace `path` with `payload` so readers see the old or new file, never a torn one. */
export function atomicWriteBytes(path: string, payload: Buffer): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const mode = existingMode(path);
  const temp = openUniqueTemp(path);
  let cleaned = false;
  try {
    writeAll(temp.fd, payload);
    fs.closeSync(temp.fd);
    fs.chmodSync(temp.path, mode);
    fs.renameSync(temp.path, path);
    cleaned = true;
  } finally {
    if (!cleaned) {
      try {
        fs.closeSync(temp.fd);
      } catch {
        // already closed
      }
      try {
        fs.unlinkSync(temp.path);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export interface AtomicWriteTextOptions {
  /** "utf-8" (default) or "utf-8-sig" (prepends a UTF-8 BOM, for Excel). */
  encoding?: "utf-8" | "utf-8-sig";
}

/** Text form of {@link atomicWriteBytes}. */
export function atomicWriteText(
  path: string,
  text: string,
  options: AtomicWriteTextOptions = {},
): void {
  const encoding = options.encoding ?? "utf-8";
  const bytes = Buffer.from(text, "utf-8");
  const payload = encoding === "utf-8-sig" ? Buffer.concat([UTF8_BOM, bytes]) : bytes;
  atomicWriteBytes(path, payload);
}
