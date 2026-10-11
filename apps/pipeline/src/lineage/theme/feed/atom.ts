/**
 * R4-3: Atom 1.0 rendering of a `theme-new-papers-v1` document
 * (`themes/<slug>/feed.xml` on the static site). Deterministic: the same
 * document always yields the same bytes (no "now" inside), so an unchanged
 * week produces no diff.
 */

import { PUBLIC_ORIGIN } from "@paperpilot/core/site";
import type { NewPapersDoc } from "./newPapers.js";

/** XML 1.0 text/attribute escape; drops characters XML 1.0 forbids. */
export function xmlEscape(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping XML-illegal control characters is the point.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

export function feedUrl(slug: string, origin: string = PUBLIC_ORIGIN): string {
  return `${origin}/themes/${slug}/feed.xml`;
}

export function themePageUrl(slug: string, origin: string = PUBLIC_ORIGIN): string {
  return `${origin}/themes/?theme=${encodeURIComponent(slug)}`;
}

/** Titles of lineage nodes, for the entry summaries. */
export type LineageTitleLookup = (nodeId: string) => string | undefined;

export function renderAtomFeed(
  doc: NewPapersDoc,
  opts: { titleOf?: LineageTitleLookup; origin?: string } = {},
): string {
  const origin = opts.origin ?? PUBLIC_ORIGIN;
  const self = feedUrl(doc.slug, origin);
  const page = themePageUrl(doc.slug, origin);
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="ja">',
    `  <id>${xmlEscape(self)}</id>`,
    `  <title>${xmlEscape(`PaperPilot 新着論文: ${doc.theme}`)}</title>`,
    `  <subtitle>${xmlEscape(
      `「${doc.theme}」の系譜の論文を ${doc.min_lineage_cites} 本以上引用している新しい論文（直近 ${doc.window.days} 日、OpenAlex より。テーマから外れる論文は除外）`,
    )}</subtitle>`,
    `  <updated>${xmlEscape(doc.generated_at)}</updated>`,
    `  <link rel="self" type="application/atom+xml" href="${xmlEscape(self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${xmlEscape(page)}"/>`,
    "  <author><name>PaperPilot</name></author>",
    '  <generator uri="https://github.com/taichiiiiiiii/automatic-paper-search">PaperPilot</generator>',
    `  <rights>${xmlEscape("論文メタデータ: OpenAlex (CC0)")}</rights>`,
  ];
  for (const item of doc.items) {
    const cited = item.cites_lineage
      .map((id) => opts.titleOf?.(id))
      .filter((t): t is string => Boolean(t));
    const shown = cited.slice(0, 3).map((t) => `「${t}」`);
    const more = item.cites_lineage.length - shown.length;
    const summary = [
      [item.venue, item.publication_date].filter(Boolean).join(" · "),
      `この系譜の ${item.cites_lineage.length} 本を引用${shown.length > 0 ? `: ${shown.join("、")}${more > 0 ? ` ほか ${more} 本` : ""}` : ""}`,
    ]
      .filter(Boolean)
      .join("。");
    const stamp = `${item.publication_date}T00:00:00Z`;
    lines.push(
      "  <entry>",
      `    <id>${xmlEscape(`https://openalex.org/${item.id.replace(/^openalex:/, "")}`)}</id>`,
      `    <title>${xmlEscape(item.title)}</title>`,
      `    <link rel="alternate" href="${xmlEscape(item.url)}"/>`,
      `    <published>${stamp}</published>`,
      `    <updated>${stamp}</updated>`,
    );
    const authors = item.authors_truncated ? [...item.authors, "et al."] : item.authors;
    for (const name of authors) {
      lines.push(`    <author><name>${xmlEscape(name)}</name></author>`);
    }
    if (authors.length === 0) lines.push("    <author><name>(unknown)</name></author>");
    lines.push(`    <summary>${xmlEscape(summary)}</summary>`, "  </entry>");
  }
  lines.push("</feed>", "");
  return lines.join("\n");
}
