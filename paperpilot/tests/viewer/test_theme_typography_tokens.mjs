// Typography token contract for the theme gallery + lineage node
// cards + edge labels.
//
// docs/assets/style.css used to carry literal font-size values
// (0.66 / 0.68 / 0.78 / 1rem) scattered across the gallery cards,
// node cards (base + theme/deep variants), and SVG edge labels.
// Issue #257 extracted four reusable tokens for this layer:
//
//   --text-caption       0.68rem   mono labels, badges, age, meta
//   --text-body-sm       0.78rem   card authors / tldr / theme badges
//   --text-card-title    1rem      gallery + base node-card title
//   --text-edge-label    0.66rem   SVG <text> on lineage edges
//
// This test pins:
//   - the four tokens exist in :root with the declared values
//   - the 14 callsites enumerated in the issue use `var(--text-...)`
//     and no longer carry a raw rem literal for these properties
//   - tokens declared in :root resolve to a sensible rem-based scale
//
// Out of scope (tracked in the post-merge follow-up issue):
//   - `.node-card--theme .node-card__title` (0.9rem) — needs its own
//     token, will be added in a separate PR alongside other 0.9rem /
//     0.95rem / 0.76rem / 0.7rem oddities that live in `.node-card--*`
//     variants.
//   - Remaining 0.68rem / 0.78rem / 0.72rem literals elsewhere in
//     style.css (hero / onboarding / topics-card / paper-tag / etc.).
//     The follow-up issue is the place to extend adoption.
//
// Run via: node paperpilot/tests/viewer/test_theme_typography_tokens.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STYLE_CSS = resolve(__dirname, "../../../docs/assets/style.css");

const rawCss = readFileSync(STYLE_CSS, "utf8");

// ---- strip CSS comments so literal-value assertions don't trip on
// "/* was 0.68rem */"-style notes left behind by the refactor. ----
function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}
const css = stripCssComments(rawCss);

// ---- helpers ----
function extractRoot(src) {
  // First :root block in the file (line 6 in style.css). We don't want
  // to greedy-match past nested braces inside the file, so walk balanced.
  const m = src.match(/:root\s*\{/);
  if (!m) throw new Error("no :root block in style.css");
  const start = m.index + m[0].length - 1;  // points at `{`
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  throw new Error("unbalanced :root block");
}

function tokenValue(rootBody, tokenName) {
  const re = new RegExp(`${tokenName.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+?)\\s*;`);
  const m = rootBody.match(re);
  return m ? m[1].trim() : null;
}

function extractSelectorBlock(src, selector) {
  // Match `<selector> { ... }` where <selector> begins a CSS rule —
  // i.e. it is preceded by `}` or `,` (group separator) or the start
  // of the file, not by another selector token. This prevents
  // `.theme-gallery__age` from matching inside the grouped selector
  // `.theme-gallery__card--active .theme-gallery__age { ... }`.
  const escaped = selector.replace(/[.[\]()+*?^$|]/g, (c) => `\\${c}`);
  const re = new RegExp(`(?:^|[}\\n,])\\s*${escaped}\\s*\\{`, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    // Walk back from the matched position to confirm the chars
    // between the boundary char and the selector are whitespace
    // only — i.e. this is genuinely the rule head and not a
    // descendant combinator like `.foo .bar { … }`.
    const selStart = m.index + m[0].indexOf(selector);
    let j = selStart - 1;
    while (j >= 0 && /[ \t]/.test(src[j])) j--;
    const boundary = src[j];
    if (boundary !== undefined && !/[}\n,]/.test(boundary)) continue;
    // Found a clean rule start. Walk forward to the matching `}`.
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(selStart, i + 1);
      }
    }
  }
  return null;
}

// ---- mini assertion harness ----
let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    console.log(`  ok  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}`);
    failed++;
  }
}

// ---- tests ----

const rootBody = extractRoot(css);

console.log("Typography tokens in :root");
const EXPECTED_TOKENS = {
  "--text-caption":          "0.68rem",
  "--text-body-sm":          "0.78rem",
  "--text-card-title":       "1rem",
  "--text-card-title-theme": "0.9rem",  // added in #266
  "--text-edge-label":       "0.66rem",
};
for (const [name, expected] of Object.entries(EXPECTED_TOKENS)) {
  const got = tokenValue(rootBody, name);
  ok(got === expected, `${name} = ${expected} (got: ${JSON.stringify(got)})`);
}

console.log("\nLegacy tokens still present (no accidental rename)");
ok(/--text-tag\s*:\s*0\.72rem/.test(rootBody), "--text-tag: 0.72rem still in :root");
ok(/--text-meta\s*:\s*0\.82rem/.test(rootBody), "--text-meta: 0.82rem still in :root");
ok(/--text-body\s*:\s*0\.95rem/.test(rootBody), "--text-body: 0.95rem still in :root");

// ---- callsite contracts ----
//
// Each tuple: (selector, expected token, the literal that must NOT
// reappear in the block).
const CALLSITES = [
  // theme-gallery cards
  [".theme-gallery__title",                    "--text-card-title", "1rem"],
  [".theme-gallery__stats",                    "--text-tag",        "0.72rem"],
  [".theme-gallery__age",                      "--text-caption",    "0.68rem"],
  [".theme-gallery__quality",                  "--text-caption",    "0.68rem"],
  // node card base
  [".node-card__title",                        "--text-card-title", "1rem"],
  [".node-card__venue",                        "--text-caption",    "0.68rem"],
  [".node-card__authors",                      "--text-body-sm",    "0.78rem"],
  [".node-card__tldr",                         "--text-body-sm",    "0.78rem"],
  [".node-card__meta",                         "--text-caption",    "0.68rem"],
  // node card theme variant overrides
  [".node-card--theme .node-card__tldr",       "--text-body-sm",    "0.78rem"],
  [".node-card--theme .node-card__authors",    "--text-body-sm",    "0.78rem"],
  [".node-card--theme .node-card__hub",        "--text-body-sm",    "0.78rem"],
  [".node-card--theme .node-card__trending",   "--text-body-sm",    "0.78rem"],
  [".node-card--theme .node-card__meta",       "--text-caption",    "0.68rem"],
  // SVG edge labels
  [".edge-label",                              "--text-edge-label", "0.66rem"],
];

console.log(`\nCallsites (${CALLSITES.length} selectors) use tokens, not literals`);
for (const [selector, token, oldLiteral] of CALLSITES) {
  const block = extractSelectorBlock(css, selector);
  ok(block !== null, `${selector}: block found`);
  if (!block) continue;
  // 1) The block must reference the expected token for font-size.
  const tokenRe = new RegExp(
    `font-size\\s*:\\s*var\\(\\s*${token.replace(/[-]/g, "\\-")}\\s*\\)\\s*;`,
  );
  ok(tokenRe.test(block), `${selector}: uses var(${token})`);
  // 2) The old literal must not appear as a font-size value here.
  //    (We strip comments above so a "/* was 0.78rem */"-style note
  //    in the comment block doesn't trip this.)
  const literalRe = new RegExp(
    `font-size\\s*:\\s*${oldLiteral.replace(/\./g, "\\.")}\\s*;`,
  );
  ok(!literalRe.test(block), `${selector}: no font-size: ${oldLiteral} literal`);
}

// ---- #266: theme-variant card title now tokenised ----
console.log("\n#266 theme variant card title");
const themeTitle = extractSelectorBlock(
  css,
  ".node-card--theme .node-card__title",
);
ok(themeTitle !== null, ".node-card--theme .node-card__title block exists");
if (themeTitle) {
  ok(/font-size\s*:\s*var\(--text-card-title-theme\)/.test(themeTitle),
     ".node-card--theme .node-card__title uses var(--text-card-title-theme)");
  ok(!/font-size\s*:\s*0\.9rem\s*;/.test(themeTitle),
     ".node-card--theme .node-card__title no 0.9rem literal");
}

// ---- #266: codebase-wide adoption ----
//
// After this PR, NO `.css` font-size declaration should carry a raw
// `0.66rem`, `0.68rem`, `0.72rem`, `0.78rem`, `0.82rem`, or `0.95rem`
// literal anywhere in style.css. The token system is now the single
// source of truth for these scale steps. Failing this check means a
// new callsite was added with a literal instead of `var(--text-…)`.
console.log("\n#266 no raw rem literals at the tokenised sizes");
const literalRe = /font-size\s*:\s*(0\.66|0\.68|0\.72|0\.78|0\.82|0\.95)rem\s*;/g;
const literals = [...css.matchAll(literalRe)].map((m) => m[1]);
ok(literals.length === 0,
   `${literals.length} raw literals remain (offenders: ${literals.join(", ") || "none"})`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
