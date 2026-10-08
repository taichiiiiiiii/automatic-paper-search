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
 * `variable` sets the generated @font-face's CSS custom property name;
 * app/globals.css's `@theme` block composes it with the same fallbacks
 * docs/assets/style.css used (e.g. `var(--font-sans-loaded), -apple-system, ...`).
 * Apply `.variable` on a shared ancestor (see app/layout.tsx) so every
 * page can use `--font-serif` / `--font-sans` / `--font-mono`.
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
  variable: "--font-serif-loaded",
  display: "swap",
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
  variable: "--font-sans-loaded",
  display: "swap",
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
  variable: "--font-mono-loaded",
  display: "swap",
});

/** Apply on a shared ancestor (app/layout.tsx's <html>) so every page's
 * CSS can resolve --font-serif / --font-sans / --font-mono. */
export const fontVariables = `${serif.variable} ${sans.variable} ${mono.variable}`;
