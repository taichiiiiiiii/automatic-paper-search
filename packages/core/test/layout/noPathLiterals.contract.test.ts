/**
 * p5-plan.md §2 A0: "a grep-style contract test that fails if `"docs"`,
 * `"paperpilot","data"` or `"paperpilot","output"` literals appear in
 * `apps/*\/src`, `apps/web/{lib,app,scripts}` or `packages/core/src`
 * (comments excluded)".
 *
 * Every one of those three literal shapes must now be expressed through
 * `layoutFor()`/`relLayout()` (this module's own `src/layout/` is the one
 * exception: it is the switch itself, and is where the literal "docs" /
 * "paperpilot/data" / "paperpilot/output" strings are meant to live, once,
 * as the mode table). A file outside `src/layout/` that still spells one
 * of these out has reintroduced a second, un-switched copy of a root the
 * data-move commit (B) needs to retarget in one place.
 *
 * Comments are excluded (the doc comments explaining the migration rule
 * legitimately say "`docs/`"/"`paperpilot/data/`" in prose) via a small
 * comment-aware stripper that still preserves string/template-literal
 * content (where a real path literal would be reintroduced).
 */
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { getRepoRoot } from "../../src/schemas/paths.js";

const REPO_ROOT = getRepoRoot();

/** Directories the plan's A0 contract test names, each repo-root-relative. */
const SCAN_DIRS = [
  "apps/pipeline/src",
  "apps/api/src",
  "apps/web/lib",
  "apps/web/app",
  "apps/web/scripts",
  "packages/core/src",
];

/** The one deliberate exception: the switch's own mode table. */
const EXEMPT_PREFIX = join(REPO_ROOT, "packages", "core", "src", "layout");

/**
 * The data-move tool (changeset A9, p5-plan.md §5.2) exists to name the
 * legacy paths it moves FROM: its rule table and .gitignore patch must
 * spell out docs/, paperpilot/data and paperpilot/output. Destinations
 * still come from relLayout("p5"). It runs once, at the cutover.
 */
const EXEMPT_DIRS: readonly string[] = [
  join(REPO_ROOT, "apps", "pipeline", "src", "release", "dataMove"),
];

/**
 * Files this A0 changeset does not own (another tier-A changeset's edit
 * scope — p5-plan.md §2) and therefore cannot route through `layoutFor()`
 * here. Each entry must be the one line in that file this test would
 * otherwise flag, with the reason it is out of THIS change's scope.
 *
 * `apps/web/scripts/legacy-redirects.ts` (changeset A8, §5.4) was
 * exempted here while its `DEFAULT_SOURCE_DIR` still hard-coded `docs/`.
 * M4 of the P5 tier-A review resolved that (it read
 * `layoutFor(REPO_ROOT).legacySite`), and since Tier C it reads only the
 * frozen `legacy/redirect/paths.json`, so the exemption stays removed.
 */
const EXEMPT_FILES: ReadonlySet<string> = new Set<string>([]);

function listSourceFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (full === EXEMPT_PREFIX || full.startsWith(`${EXEMPT_PREFIX}/`)) continue;
    if (EXEMPT_DIRS.some((d) => full === d || full.startsWith(`${d}/`))) continue;
    if (EXEMPT_FILES.has(relative(REPO_ROOT, full))) continue;
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * True if a bare `/` at the current position in `out` (what has been
 * emitted so far) starts a regex literal rather than a division/operator
 * `/` — the standard heuristic: a regex cannot immediately follow an
 * identifier, number, `)`, or `]` (those mean "divide"); anything else
 * (operator, `(`, `,`, `return`, start of file, ...) means "regex".
 */
function looksLikeRegexContext(out: string): boolean {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j] as string)) j -= 1;
  if (j < 0) return true;
  return !/[A-Za-z0-9_$)\]]/.test(out[j] as string);
}

/**
 * Blanks out `//` and `/* ... *\/` comment content (replacing it with
 * spaces/newlines so reported line numbers stay correct) while leaving
 * every string, template literal, and regex literal's content untouched
 * (a regex literal is passed through opaquely — via
 * {@link looksLikeRegexContext} — specifically so a quote character
 * inside one, e.g. `/"/g`, cannot be mistaken for the start of a string
 * and desynchronize the rest of the scan). Not a full TS tokenizer
 * (template-literal `${}` holes are not specially handled), but
 * sufficient to tell "a word in a doc comment" apart from "a literal in
 * actual code".
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    const ch = src[i] as string;
    if (two === "//") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (two === "/*") {
      out += "  ";
      i += 2;
      while (i < n && src.slice(i, i + 2) !== "*/") {
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < n) {
          out += (src[i] as string) + (src[i + 1] as string);
          i += 2;
          continue;
        }
        out += src[i] as string;
        i += 1;
      }
      if (i < n) {
        out += src[i];
        i += 1;
      }
      continue;
    }
    if (ch === "/" && looksLikeRegexContext(out)) {
      out += ch;
      i += 1;
      let inClass = false;
      let closed = false;
      while (i < n && src[i] !== "\n") {
        const c = src[i] as string;
        if (c === "\\" && i + 1 < n) {
          out += c + src[i + 1];
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          closed = true;
          break;
        }
      }
      if (closed) {
        while (i < n && /[a-z]/i.test(src[i] as string)) {
          out += src[i];
          i += 1;
        }
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

interface ForbiddenPattern {
  name: string;
  re: RegExp;
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  { name: '"docs"', re: /"docs"/g },
  { name: "'docs'", re: /'docs'/g },
  { name: "`docs`", re: /`docs`/g },
  { name: '"docs/...', re: /"docs\// },
  { name: "'docs/...", re: /'docs\// },
  { name: "`docs/...", re: /`docs\// },
  {
    name: '"paperpilot","data"',
    re: /["']paperpilot["']\s*,\s*["']data["']/g,
  },
  {
    name: '"paperpilot","output"',
    re: /["']paperpilot["']\s*,\s*["']output["']/g,
  },
  { name: "paperpilot/data", re: /paperpilot\/data/g },
  { name: "paperpilot/output", re: /paperpilot\/output/g },
];

interface Violation {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const relDir of SCAN_DIRS) {
    const files = listSourceFiles(join(REPO_ROOT, relDir));
    for (const file of files) {
      const raw = readFileSync(file, "utf-8");
      const stripped = stripComments(raw);
      const lines = stripped.split("\n");
      for (const { name, re } of FORBIDDEN_PATTERNS) {
        for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
          const line = lines[lineNo] as string;
          re.lastIndex = 0;
          if (re.test(line)) {
            violations.push({
              file: relative(REPO_ROOT, file),
              line: lineNo + 1,
              pattern: name,
              snippet: line.trim().slice(0, 160),
            });
          }
        }
      }
    }
  }
  return violations;
}

describe("A0 contract: no leftover docs/ / paperpilot/data / paperpilot/output path literal", () => {
  it("every call site resolves through layoutFor()/relLayout(), not a hard-coded path", () => {
    const violations = findViolations();
    if (violations.length > 0) {
      const report = violations
        .map((v) => `${v.file}:${v.line} [${v.pattern}] ${v.snippet}`)
        .join("\n");
      expect.fail(
        `found ${violations.length} leftover path literal(s) outside packages/core/src/layout:\n${report}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("the scan itself still finds real source files (the check isn't vacuously passing)", () => {
    const total = SCAN_DIRS.reduce(
      (sum, relDir) => sum + listSourceFiles(join(REPO_ROOT, relDir)).length,
      0,
    );
    expect(total).toBeGreaterThan(50);
  });

  it("the layout module itself is exempt (it is the switch, not a leftover)", () => {
    const layoutFile = join(REPO_ROOT, "packages", "core", "src", "layout", "index.ts");
    const raw = readFileSync(layoutFile, "utf-8");
    // Sanity: the exempted file really does contain the literal (otherwise
    // this test would be exempting nothing and the exemption logic itself
    // would be untested).
    expect(raw).toContain('"docs"');
    expect(raw).toContain("paperpilot/data");
    expect(raw).toContain("paperpilot/output");
  });
});
