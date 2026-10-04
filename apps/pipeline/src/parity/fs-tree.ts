import { promises as fs } from "node:fs";
import path from "node:path";

export interface SkippedEntry {
  /** Posix-style path relative to `root`. */
  path: string;
  reason: "dangling-symlink" | "symlink-to-directory";
}

export interface ListFilesResult {
  /** Every regular file under `root`, as posix-style paths relative to `root`, sorted. */
  files: string[];
  /**
   * Symlinks this walk could not treat as an ordinary file: a dangling
   * symlink (target does not exist) or a symlink to a directory (its
   * contents are not walked — Python's side of a parity comparison would
   * never produce one, and silently excluding it from both `files` and
   * any diagnostic risks comparing two trees as "equal" while one of them
   * has content neither side ever actually looked at).
   */
  skipped: SkippedEntry[];
}

/** Lists every regular file under `root`; see {@link ListFilesResult.skipped} for symlinks this can't resolve to a plain file. */
export async function listFiles(root: string): Promise<ListFilesResult> {
  const files: string[] = [];
  const skipped: SkippedEntry[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        files.push(toPosix(path.relative(root, abs)));
      } else if (entry.isSymbolicLink()) {
        const stat = await fs.stat(abs).catch(() => null);
        if (stat === null) {
          skipped.push({ path: toPosix(path.relative(root, abs)), reason: "dangling-symlink" });
        } else if (stat.isFile()) {
          files.push(toPosix(path.relative(root, abs)));
        } else if (stat.isDirectory()) {
          skipped.push({
            path: toPosix(path.relative(root, abs)),
            reason: "symlink-to-directory",
          });
        }
      }
    }
  }

  await walk(root);
  files.sort();
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}

export function readFileBytes(absPath: string): Promise<Buffer> {
  return fs.readFile(absPath);
}

/**
 * Decode a file as UTF-8 text, strictly: `fs.readFile(path, "utf8")`
 * silently replaces any invalid byte sequence with U+FFFD, which could
 * make two files with DIFFERENT invalid bytes decode to the SAME
 * replacement-character text and compare as falsely "equal" — exactly the
 * kind of corruption a byte-identity check exists to catch. `TextDecoder`
 * with `fatal: true` throws instead, so the caller can report it as a
 * clear parse/decode error rather than silently losing information.
 */
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export async function readFileText(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  try {
    return STRICT_UTF8_DECODER.decode(buf);
  } catch {
    throw new Error(`invalid UTF-8 in ${absPath}`);
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
