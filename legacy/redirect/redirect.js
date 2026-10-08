/**
 * Browser-side redirect for the legacy GitHub Pages site
 * (https://taichiiiiiiii.github.io/automatic-paper-search/*). Loaded by
 * every page apps/web/scripts/legacy-redirects.ts generates, via
 * `<script src="/automatic-paper-search/redirect.js">`. The CSP on
 * those pages is `default-src 'none'; script-src 'self'`, so this file
 * must stay dependency-free and must never need an inline `<script>`.
 *
 * Plain ES5, no build step runs over this file. UMD guard: when
 * `module`/`module.exports` exist (Node/Vitest importing this file for
 * tests) the mapping functions are exported instead of touching
 * `window` or navigating -- importing this file in a test never
 * triggers a real redirect. docs/migration/p5-plan.md §5.4.
 *
 * NEW_ORIGIN below is a placeholder token substituted by the generator
 * (apps/web/scripts/legacy-redirects.ts) with the live
 * `@paperpilot/core` `PUBLIC_ORIGIN` value. Keep the exact token
 * "%%NEW_ORIGIN%%" in sync between the two files.
 *
 * The path mapping below must keep agreeing with the Cloudflare Pages
 * `_redirects` rules (apps/web/scripts/redirects.ts LEGACY_HTML_RULES)
 * for every shape they both handle -- pinned by
 * apps/web/test/legacy-redirects/cloudflare-parity.test.ts. Cloudflare
 * never sees the GitHub Pages prefix, so it has no equivalent of
 * `stripPrefix` below.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LegacyRedirect = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LEGACY_PREFIX = "/automatic-paper-search";
  var NEW_ORIGIN = "%%NEW_ORIGIN%%";

  // A bare prefix (no trailing path, with or without a trailing slash)
  // maps to "/", never "".
  function stripPrefix(pathname) {
    if (pathname === LEGACY_PREFIX) {
      return "/";
    }
    if (pathname.indexOf(LEGACY_PREFIX + "/") === 0) {
      return pathname.slice(LEGACY_PREFIX.length);
    }
    return pathname;
  }

  function mapPath(pathname) {
    var path = stripPrefix(pathname);
    var m = path.match(/^\/([^/]+)\/(lineage|deep|paper-links)\.html$/);
    if (m) {
      return "/" + m[1] + "/" + m[2] + "/";
    }
    m = path.match(/^\/([^/]+)\/index\.html$/);
    if (m) {
      return "/" + m[1] + "/";
    }
    if (path === "/index.html") {
      return "/";
    }
    return path;
  }

  // search and hash are carried through verbatim (never parsed/decoded
  // or re-encoded), per p5-plan.md §5.4 "Preserve location.search and
  // location.hash verbatim."
  function mapUrl(pathname, search, hash) {
    return NEW_ORIGIN + mapPath(pathname) + (search || "") + (hash || "");
  }

  function redirect() {
    var loc = window.location;
    loc.replace(mapUrl(loc.pathname, loc.search, loc.hash));
  }

  return {
    LEGACY_PREFIX: LEGACY_PREFIX,
    NEW_ORIGIN: NEW_ORIGIN,
    stripPrefix: stripPrefix,
    mapPath: mapPath,
    mapUrl: mapUrl,
    redirect: redirect,
  };
});

// Only reached on a real page load (classic <script> tag, no module
// system): module.exports above wins whenever this file is imported
// for a test, so this never fires there.
if (typeof window !== "undefined" && window.LegacyRedirect) {
  window.LegacyRedirect.redirect();
}
