/**
 * Minimal glob matcher (no dependency allowed). Supports `*` (any run of characters
 * except `/`), `**` (any run of characters including `/`, including zero directories
 * when followed by `/`), and `?` (any single character except `/`). Matched against
 * posix-style relative paths.
 */

const REGEXP_ESCAPE = /[/\\^$.|+()[\]{}]/;

export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          pattern += "(?:.*/)?";
          i += 3;
          continue;
        }
        pattern += ".*";
        i += 2;
        continue;
      }
      pattern += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      pattern += "[^/]";
      i += 1;
      continue;
    }
    if (c !== undefined && REGEXP_ESCAPE.test(c)) {
      pattern += `\\${c}`;
      i += 1;
      continue;
    }
    pattern += c;
    i += 1;
  }
  return new RegExp(`^${pattern}$`);
}

export function matchGlob(glob: string, filePath: string): boolean {
  return globToRegExp(glob).test(filePath);
}
