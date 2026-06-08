// CLS reservation invariant for the theme gallery wrapped layout.
//
// docs/assets/style.css reserves a `min-height` on `.theme-gallery`
// under `@media (min-width: 1440px)` so the canvas below stays put
// while the manifest fetch is in flight. The right value depends on
// the *expected* row count once the gallery is populated; getting it
// wrong reintroduces the very CLS the reservation was supposed to
// defend against.
//
// Two historical phases:
//   1) Pre-PR #260: 21 seed themes → up to 4 wrapped rows on 1920px
//      → 290px reservation, comment acknowledged ~70px under-reserve.
//   2) Post-PR #260 (current): site-request-only; manifest holds a
//      handful of themes → at most 1 row → 290px over-reserves by
//      ~212px, creating a visible blank void below the gallery. The
//      defensible CLS reservation is therefore the 1-row floor:
//      calc(68px + 0.6rem), matching the nowrap baseline outside the
//      media query.
//
// What this guards:
//   - The 1440px @media block reserves exactly one card row, not the
//     pre-#260 290px (regression to over-reservation) and not a
//     stepped 290→360→450 ladder (latent over-reservation at all
//     wider viewports while gallery is small).
//   - No 1920px / 2560px `min-width` step on `.theme-gallery` exists.
//     If gallery grows past ~10 themes the follow-up issue will
//     revisit the design; until then those steps must stay absent so
//     they don't ship over-reservation by default.
//   - manifest length stays small (alarm threshold = 10). When it
//     grows past that we want this test to FAIL so the follow-up
//     issue is forced into scope.
//
// Run via: node paperpilot/tests/viewer/test_theme_gallery_cls_reservation.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STYLE_CSS = resolve(__dirname, "../../../docs/assets/style.css");
const MANIFEST = resolve(
  __dirname,
  "../../../docs/themes/themes-manifest.json",
);

const cssSrc = readFileSync(STYLE_CSS, "utf8");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

// ---- helper: extract a media-query block + targeted rule ----
//
// Match `@media (min-width: <N>px) { … }`, then within that block
// match `.theme-gallery { … min-height: <value>; … }`. Whitespace
// tolerant so a future minifier / formatter pass doesn't break us.
function findMediaBlock(src, minWidthPx) {
  const re = new RegExp(
    `@media\\s*\\(\\s*min-width:\\s*${minWidthPx}px\\s*\\)\\s*\\{`,
    "g",
  );
  const m = re.exec(src);
  if (!m) return null;
  let depth = 0;
  let i = m.index + m[0].length - 1;  // position of the opening `{`
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(m.index, i + 1);
      }
    }
  }
  return null;
}

function galleryMinHeight(block) {
  if (!block) return null;
  // Match `.theme-gallery { ... min-height: <value>; ... }`.
  const ruleRe = /\.theme-gallery\s*\{([^}]*)\}/;
  const r = block.match(ruleRe);
  if (!r) return null;
  const body = r[1];
  const propRe = /min-height\s*:\s*([^;]+?)\s*;/;
  const p = body.match(propRe);
  return p ? p[1].trim() : null;
}

// ---- mini assertion harness (matches sibling .mjs scripts) ----
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

console.log("Gallery wrap reservation (@media min-width 1440px)");
const wrapBlock = findMediaBlock(cssSrc, 1440);
ok(wrapBlock !== null, "1440px media block exists");

const mh1440 = galleryMinHeight(wrapBlock);
ok(mh1440 !== null, ".theme-gallery defines min-height in the 1440 block");

// The contract: one card row + the gallery top padding. This matches
// the nowrap baseline at line 1589 — `calc(68px + 0.6rem)` — so the
// reservation is consistent across the wrap/nowrap boundary. Spaces
// inside calc() are normalised before comparison.
const normalised = (mh1440 || "").replace(/\s+/g, "");
ok(
  normalised === "calc(68px+0.6rem)",
  `min-height is calc(68px + 0.6rem) (got: ${JSON.stringify(mh1440)})`,
);

console.log("\nNo over-reservation steps for wider viewports");
ok(
  findMediaBlock(cssSrc, 1920) === null ||
    !/\.theme-gallery\s*\{[^}]*min-height/.test(
      findMediaBlock(cssSrc, 1920) || "",
    ),
  "no .theme-gallery min-height at @media (min-width: 1920px)",
);
ok(
  findMediaBlock(cssSrc, 2560) === null ||
    !/\.theme-gallery\s*\{[^}]*min-height/.test(
      findMediaBlock(cssSrc, 2560) || "",
    ),
  "no .theme-gallery min-height at @media (min-width: 2560px)",
);

console.log("\nManifest size sanity (alarms when ≥10 → revisit reservation)");
ok(Array.isArray(manifest), "manifest parses as array");
ok(
  manifest.length < 10,
  `manifest holds ${manifest.length} themes (< 10 alarm threshold); ` +
    "when this fails open the follow-up issue and reintroduce a wrap-row reservation",
);

// Sanity that the comment block survives — we don't want a future
// editor to drop the "site-request-only" / "revisit at scale" hint
// and silently re-introduce 290px. The comment markers are:
//   - "site-request-only" or "site-request only"  (post-#260 context)
//   - "1-row" or "single-row" or "one row"        (reservation strategy)
console.log("\nCSS comment provenance still intact");
ok(
  /site-request[ -]?only/i.test(wrapBlock || ""),
  "comment references the site-request-only context",
);
ok(
  /(one|1|single)[-\s]row|row[-\s]floor/i.test(wrapBlock || ""),
  "comment documents the 1-row reservation strategy",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
