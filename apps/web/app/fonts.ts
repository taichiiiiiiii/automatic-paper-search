import localFont from "next/font/local";

/**
 * Latin web fonts, self-hosted via next/font/local from the installed
 * @fontsource-variable packages (no Google Fonts fetch at request time,
 * matching the current docs/assets/style.css stacks and the CSP's
 * `font-src 'self'` -- design doc §4.4-3).
 *
 * Each family ships one variable-weight (`wght` axis) woff2 per
 * script-subset / style combination; "latin" + "latin-ext" normal +
 * italic is what docs/assets/style.css needs (Cyrillic/Greek/Vietnamese
 * subsets exist in the packages but are not used anywhere on this site).
 * Newsreader also offers a separate `opsz` (optical size) axis file,
 * which is intentionally not loaded here -- only the weight axis is
 * wired up, matching the simpler, weight-only use in the current CSS.
 *
 * One font per subset, each with the fontsource `unicode-range`
 * (Lighthouse run 2026-10-12): next/font/local cannot give each `src`
 * file its own range, and with latin + latin-ext in one family and no
 * range at all, Chrome downloaded BOTH files of every face a page used --
 * and the italic faces just for the Japanese text inside `<em>`, which
 * needs no Latin glyph: 6-8 woff2 / ~280-440 KB on every page. Now a face
 * is fetched only when the page has characters in its range (latin-ext:
 * author names with ł, ő, ș, …). next/font requires literal option values,
 * hence the repeated range strings.
 *
 * app/globals.css's stacks are `var(--font-X-loaded),
 * var(--font-X-ext-loaded), <system fonts>`. The latin font has no
 * generated fallback (`adjustFontFallback: false`); the metric-adjusted
 * Arial fallback comes with the ext font (same family, same metrics) and
 * so sits AFTER both web fonts: a latin-ext character reaches the ext
 * face instead of being caught by local Arial first, and the swap period
 * still renders with the metric-matched fallback (no extra CLS).
 *
 * `variable` sets the generated @font-face's CSS custom property name;
 * apply all of them on a shared ancestor (app/layout.tsx's <html>).
 *
 * `preload: false` (UX audit, design 53): with preload on, every page
 * started with 12 `<link rel="preload">` woff2 downloads (~640 KB)
 * whether or not the page used them.
 */

export const serif = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2",
      weight: "100 800",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/newsreader/files/newsreader-latin-wght-italic.woff2",
      weight: "100 800",
      style: "italic",
    },
  ],
  variable: "--font-serif-loaded",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
});

export const serifExt = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/newsreader/files/newsreader-latin-ext-wght-normal.woff2",
      weight: "100 800",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/newsreader/files/newsreader-latin-ext-wght-italic.woff2",
      weight: "100 800",
      style: "italic",
    },
  ],
  variable: "--font-serif-ext-loaded",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
});

export const sans = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-sans-loaded",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
});

export const sansExt = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-sans-ext-loaded",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
});

export const mono = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
      weight: "100 800",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-italic.woff2",
      weight: "100 800",
      style: "italic",
    },
  ],
  variable: "--font-mono-loaded",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
});

export const monoExt = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2",
      weight: "100 800",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-italic.woff2",
      weight: "100 800",
      style: "italic",
    },
  ],
  variable: "--font-mono-ext-loaded",
  display: "swap",
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    },
  ],
});

/** Apply on a shared ancestor (app/layout.tsx's <html>) so every page's
 * CSS can resolve --font-serif / --font-sans / --font-mono. */
export const fontVariables = [serif, serifExt, sans, sansExt, mono, monoExt]
  .map((f) => f.variable)
  .join(" ");
