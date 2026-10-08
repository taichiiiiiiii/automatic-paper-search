/**
 * Client-side SVG/PNG export for the theme lineage canvas -- port of
 * docs/assets/theme.js's `exportImage()` / `buildSelfContainedSvg()` /
 * `collectInlineCss()` / `downloadBlob()`, no new dependencies (SVG
 * export via XMLSerializer, PNG via <canvas>).
 *
 * The three pure decision/formatting helpers below (`exportFilenameBase`,
 * `isSameOriginStylesheet`, `pngExportScale`) are unit-tested in
 * test/themes/export.test.ts. The rest of this file talks to the DOM
 * (XMLSerializer, Image, HTMLCanvasElement, Blob, <a download>) and has
 * no jsdom/Vitest-friendly pure shape to test -- same situation as the
 * original's exportImage(), which paperpilot/tests/viewer/* never unit
 * tested either; it is exercised through the running app instead (see
 * the P2 brief: "test logic as pure functions ... verify rendering via
 * the built HTML where useful").
 */

/** Shared filename base for both export kinds: "<slug>-lineage-<date>". */
export function exportFilenameBase(
  slug: string | null | undefined,
  now: Date = new Date(),
): string {
  const safeSlug = slug?.trim() ? slug : "theme";
  const date = now.toISOString().slice(0, 10);
  return `${safeSlug}-lineage-${date}`;
}

/** Only same-origin stylesheets get inlined into the exported
 * self-contained SVG -- never a rule injected by a browser extension
 * or third-party script (same security rationale as docs/assets/
 * theme.js's `collectInlineCss()`, generalised from its hardcoded
 * "/assets/style.css" href check to "same origin as the page" since
 * this app's build-generated CSS filename is not a fixed string). */
export function isSameOriginStylesheet(
  href: string | null | undefined,
  pageOrigin: string,
): boolean {
  if (!href) return false;
  try {
    return new URL(href, pageOrigin).origin === pageOrigin;
  } catch {
    return false;
  }
}

/** PNG raster scale factor: cap the longer edge at `cap` px (default
 * 8000, matching the original), never upscale past 2x. */
export function pngExportScale(width: number, height: number, cap = 8000): number {
  const longest = Math.max(width, height, 1);
  return Math.min(2, cap / longest);
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

function collectInlineCss(doc: Document): string {
  const origin = doc.location?.origin ?? "";
  const parts: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    if (!isSameOriginStylesheet(sheet.href, origin)) continue;
    try {
      for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText);
    } catch {
      // Same-origin should never throw, but a transient SecurityError
      // (e.g. a stylesheet still loading) should not abort the export.
    }
  }
  return parts.join("\n");
}

/** Clones `svgEl`, inlines every same-origin stylesheet rule into a
 * `<style>` in `<defs>` so the serialized string renders identically
 * with no external CSS, and returns the serialized XML string. The
 * clone is never attached to the document. */
export function buildSelfContainedSvgString(svgEl: SVGSVGElement): string {
  const doc = svgEl.ownerDocument;
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  const cssText = collectInlineCss(doc);
  let defs = clone.querySelector("defs");
  if (!defs) {
    defs = doc.createElementNS(SVG_NS, "defs");
    clone.insertBefore(defs, clone.firstChild);
  }
  const style = doc.createElementNS(SVG_NS, "style");
  style.textContent = cssText;
  defs.appendChild(style);
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("xmlns:xhtml", XHTML_NS);
  return new (doc.defaultView ?? window).XMLSerializer().serializeToString(clone);
}

/** Creates a transient `<a download>` to trigger a browser download of
 * `blob`, then revokes the object URL synchronously after the click
 * (the download manager already holds its own reference by then). */
export function downloadBlob(doc: Document, blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = filename;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ExportSvgOptions {
  slug: string | null | undefined;
  now?: Date;
}

/** Downloads the self-contained SVG as a `.svg` file. */
export function exportSvg(svgEl: SVGSVGElement, { slug, now }: ExportSvgOptions): void {
  const xml = buildSelfContainedSvgString(svgEl);
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`], {
    type: "image/svg+xml;charset=utf-8",
  });
  downloadBlob(svgEl.ownerDocument, blob, `${exportFilenameBase(slug, now)}.svg`);
}

export interface ExportPngOptions extends ExportSvgOptions {
  /** Background fill color (the app's `--color-bg` token value). */
  background: string;
}

/**
 * Rasterizes the self-contained SVG to a PNG via <canvas>. SVGs
 * containing `<foreignObject>` (every card here) taint the canvas in
 * most browsers -- `toBlob` then throws/returns null -- so on any
 * failure this falls back to the SVG download instead of silently
 * producing nothing, exactly like the original's exportImage("png").
 */
export async function exportPng(
  svgEl: SVGSVGElement,
  { slug, now, background }: ExportPngOptions,
): Promise<void> {
  const doc = svgEl.ownerDocument;
  const win = doc.defaultView ?? window;
  const xml = buildSelfContainedSvgString(svgEl);
  const width = Number.parseFloat(svgEl.getAttribute("width") ?? "") || 1;
  const height = Number.parseFloat(svgEl.getAttribute("height") ?? "") || 1;
  const scale = pngExportScale(width, height);
  const canvasWidth = Math.round(width * scale);
  const canvasHeight = Math.round(height * scale);

  const canvas = doc.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    exportSvg(svgEl, { slug, now });
    return;
  }
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const img = new win.Image();
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG image load failed"));
      img.src = svgUrl;
    });
    ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
  } catch (err) {
    console.warn("PNG export failed:", err);
    exportSvg(svgEl, { slug, now });
    return;
  }

  await new Promise<void>((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(doc, blob, `${exportFilenameBase(slug, now)}.png`);
      } else {
        console.warn("PNG export blob came back null -- falling back to SVG.");
        exportSvg(svgEl, { slug, now });
      }
      canvas.width = 0;
      canvas.height = 0;
      resolve();
    }, "image/png");
  });
}
