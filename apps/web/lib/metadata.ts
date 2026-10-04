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
  /** Omit when no OG image asset is published yet for this page. */
  ogImage?: OgImage;
}

export function buildMetadata(options: BuildMetadataOptions): Metadata {
  const url = canonicalUrl(options.path);
  const images = options.ogImage
    ? [
        {
          url: canonicalUrl(options.ogImage.path),
          width: options.ogImage.width,
          height: options.ogImage.height,
          alt: options.ogImage.alt,
        },
      ]
    : undefined;

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
      card: images ? "summary_large_image" : "summary",
      title: options.title,
      description: options.description,
      images: images?.map((img) => img.url),
    },
  };
}
