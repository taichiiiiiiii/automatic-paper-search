// Static-analysis guard for docs/assets/search.js.
//
// Why this exists:
//
// search.js renders paper titles that come from search-index.json, which
// is generated from scraped conference metadata — text nobody on this
// project writes or reviews. Five real titles in the current catalog
// already contain angle brackets (e.g. "Reasoning to Attend: Try to
// Understand How <SEG> Token Works"), so this is not a hypothetical.
//
// The first version of this file built result rows with innerHTML and
// leaned on an escapeHtml helper looked up as:
//
//     const escapeHtml = (window.PP && window.PP.escapeHtml) || ((s) => String(s));
//
// If utils.js failed to load, that fallback silently became the identity
// function and every title went into innerHTML unescaped — the defence
// disappeared with no error. The fix was to stop producing HTML strings
// at all and build DOM nodes with textContent, which has no escaping step
// to skip.
//
// This guard keeps it that way: assert search.js assigns no innerHTML /
// outerHTML / insertAdjacentHTML, and does not depend on window.PP.
//
// Run via: node paperpilot/tests/viewer/test_search_untrusted_text.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../../../docs/assets/search.js");
const src = readFileSync(SRC, "utf8");

// Strip comments so the prose above (and in search.js itself) cannot
// trip the checks below.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : " — " + detail}`);
  if (!ok) failures++;
}

const BANNED = [
  ["innerHTML assignment", /\.innerHTML\s*(=|\+=)/],
  ["outerHTML assignment", /\.outerHTML\s*(=|\+=)/],
  ["insertAdjacentHTML", /insertAdjacentHTML\s*\(/],
  ["document.write", /document\s*\.\s*write\s*\(/],
];
for (const [name, re] of BANNED) {
  check(`no ${name}`, !re.test(code), `found ${re}`);
}

// The escaping-helper dependency is what silently degraded. Untrusted text
// must reach the DOM through textContent, never through a helper that can
// go missing.
check(
  "no window.PP dependency",
  !/window\s*\.\s*PP/.test(code),
  "search.js must not rely on a helper that can fail to load"
);
check(
  "uses textContent for untrusted text",
  /\.textContent\s*=/.test(code),
  "expected titles to be set with textContent"
);

// A hostile title must not be able to leave the ?q= value and add
// attributes to the anchor.
check(
  "href value is percent-encoded",
  /encodeURIComponent\s*\(/.test(code),
  "expected encodeURIComponent around the ?q= value"
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
