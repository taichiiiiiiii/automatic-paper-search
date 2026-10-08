// Minimal JSONC reader for the wrangler config tests. No JSONC-parsing
// dependency exists anywhere in this monorepo (grep confirms it, and
// CLAUDE.md's TS migration rules forbid adding new dependencies for a
// Tier A changeset), so this strips `//` and `/* */` comments by hand,
// tracking string-literal state so a comment marker inside a quoted
// string (e.g. a URL with "//") is never treated as a comment. Every
// wrangler.jsonc in this repo uses only `//` line comments today, but
// `/* */` is handled too since JSONC allows it and a future edit could
// introduce one.
export function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Preserve the escaped character verbatim (handles `\"`).
        out += next ?? "";
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Parses a `.jsonc` file's text into a plain JS value. */
export function parseJsonc(source: string): unknown {
  return JSON.parse(stripJsonComments(source));
}
