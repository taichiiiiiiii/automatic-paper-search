/**
 * Builds a Next.js `Metadata` object with canonical + Open Graph / Twitter
 * tags derived from @paperpilot/core's config (never hard-coded URLs --
 * design doc §4.1-4.2: the whole point of moving off GitHub Pages is that
 * the origin and path prefix live in exactly one place).
 *
 * Usage (any page, e.g. app/cvpr-2026/page.tsx):
 *
 *   export const metadata = buildMetadata({
 *     path: "/cvpr-2026/",
 *     title: "CVPR 2026 — PaperPilot",
 *     description: "...",
 *   });
 */
import type { Metadata } from "next";
import { canonicalUrl } from "./config";

export interface OgImage {
  path: string; // site-relative, e.g. "/assets/og-image.png"
  width: number;
  height: number;
  alt: string;
}

export interface BuildMetadataOptions {
  /** Site-relative path, starting with "/" (e.g. "/", "/cvpr-2026/"). */
  path: string;
  title: string;
  description: string;
  /** Overrides the site-wide default OG image (DEFAULT_OG_IMAGE) for a
   * page that has its own. */
  ogImage?: OgImage;
}

/** Published by `scripts/copy-data.ts` into `public/assets/og-image.png`
 * (copied from `docs/assets/og-image.png`). Every page gets at least
 * this image in its Open Graph / Twitter Card tags -- the current
 * docs/*.html site sets the identical image + dimensions on every page
 * (only the alt text differs per page), and omitting it entirely (the
 * prior behaviour when a page did not pass `ogImage`) is a head-parity
 * regression, not an intentional "no image" state. */
const DEFAULT_OG_IMAGE: OgImage = {
  path: "/assets/og-image.png",
  width: 1200,
  height: 630,
  alt: "PaperPilot — AI/ML トップ会議の採択論文を横断検索",
};

export function buildMetadata(options: BuildMetadataOptions): Metadata {
  const url = canonicalUrl(options.path);
  const ogImage = options.ogImage ?? DEFAULT_OG_IMAGE;
  const images = [
    {
      url: canonicalUrl(ogImage.path),
      width: ogImage.width,
      height: ogImage.height,
      alt: ogImage.alt,
    },
  ];

  return {
    title: options.title,
    description: options.description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      url,
      title: options.title,
      description: options.description,
      type: "website",
      siteName: "PaperPilot",
      locale: "ja_JP",
      images,
    },
    twitter: {
      card: "summary_large_image",
      title: options.title,
      description: options.description,
      images: images.map((img) => img.url),
    },
  };
}
