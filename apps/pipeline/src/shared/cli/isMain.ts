/**
 * Shared "was this file run as the entry script" guard (M2 of the P4
 * review). Every CLI in this package used to write its own
 * `import.meta.url === \`file://${process.argv[1]}\`` check — a plain
 * string comparison that silently goes `false` (CLI becomes a no-op that
 * exits 0) the moment the invocation path differs textually from this
 * file's own `import.meta.url` even though both name the same file: a
 * symlinked directory, a path containing a space (the space isn't
 * percent-encoded by `file://${argv[1]}` the way a real `file://` URL
 * would encode it), or a non-ASCII path all break the comparison.
 *
 * `isMain` instead resolves BOTH sides to their real filesystem path
 * (`realpathSync`, which follows symlinks) and compares those — a
 * symlinked invocation path and this file's own path resolve to the same
 * real path either way, and no URL-escaping mismatch is possible because
 * neither side is ever turned into a URL string for the comparison.
 *
 * Windows is out of scope (this package only runs under Node on
 * macOS/Linux CI per docs/design/39-typescript-cloudflare-migration.md).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `true` exactly when this module was invoked as the process's entry
 * script. Pass the caller's own `import.meta.url` — `isMain` compares its
 * real path against `process.argv[1]`'s real path. Never throws: `false`
 * (never a crash) when `argv[1]` is missing/empty, when `importMetaUrl`
 * or `argv[1]` cannot be resolved to a real file (e.g. this module was
 * only imported, not run, or the invoking path no longer exists), or on
 * any other `fs`/`url` error.
 */
export function isMain(importMetaUrl: string): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const thisFile = realpathSync(fileURLToPath(importMetaUrl));
    const invokedFile = realpathSync(invoked);
    return thisFile === invokedFile;
  } catch {
    return false;
  }
}
