"use client";

import {
  type CodeLink,
  compactCount,
  type ThemeCodeLinks,
  type ThemeNewPapers,
  themeFeedPath,
} from "../../lib/themes-feed";
/**
 * R4-3 (design 48 P1-1 / P1-2): two sections under the theme lineage.
 *
 *  - 「新着」: recent papers (OpenAlex) that cite at least two papers of
 *    this lineage and pass the theme topic gate, with the Atom feed link.
 *    They are NOT part of the lineage graph.
 *  - 「コードとモデル」: the lineage papers' code repository and Hugging
 *    Face Papers page (models / datasets / Spaces counts), with the
 *    attribution the sources need.
 *
 * Both render nothing when their file is missing (pure props).
 */
import type { LineageNode } from "../../lib/themes-quality";

function nodeTitle(nodes: readonly LineageNode[], id: string): string {
  const n = nodes.find((x) => x.id === id);
  return (n && typeof n.title === "string" && n.title) || id;
}

export function ThemeNewPapersSection({
  slug,
  data,
  nodes,
}: {
  slug: string;
  data: ThemeNewPapers | null;
  nodes: readonly LineageNode[];
}) {
  if (!data) return null;
  return (
    <section
      aria-labelledby="new-papers-heading"
      className="rounded-md border border-rule bg-surface"
      data-new-papers
    >
      <details className="group p-4">
        <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
          <h2 id="new-papers-heading" className="font-serif text-lg font-semibold text-ink">
            新着
            <span className="ml-2 text-sm font-normal text-ink-subtle">
              {data.items.length} 本・{data.window.from} 〜 {data.window.to}
            </span>
          </h2>
          <span aria-hidden="true" className="text-xs text-ink-subtle group-open:hidden">
            開く ▾
          </span>
        </summary>
        <p className="mt-2 text-xs text-ink-subtle">
          この系譜の論文を {data.minLineageCites} 本以上引用している新しい論文です（OpenAlex
          の引用データ、テーマから外れる論文は自動で除外）。系譜の図には含めていません。OpenAlex
          への登録は公開から数日〜数週間遅れることがあります。
          <a
            href={themeFeedPath(slug)}
            type="application/atom+xml"
            className="ml-1 text-accent-strong underline"
            data-feed-link
          >
            Atom フィード
          </a>
        </p>
        {data.items.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">この期間の新着はありません。</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {data.items.map((it) => {
              const cited = it.citesLineage.map((id) => nodeTitle(nodes, id));
              const authors = it.authors.join(", ") + (it.authorsTruncated ? " ほか" : "");
              return (
                <li key={it.id} className="text-sm">
                  <a
                    href={it.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-ink underline decoration-rule hover:text-accent"
                  >
                    {it.title}
                  </a>
                  <div className="text-xs text-ink-subtle">
                    {[it.publicationDate, it.venue, authors].filter(Boolean).join(" · ")}
                  </div>
                  <div className="text-xs text-ink-muted" title={cited.join("\n")}>
                    系譜の {it.citesLineage.length} 本を引用: {cited.slice(0, 3).join("、")}
                    {cited.length > 3 ? ` ほか ${cited.length - 3} 本` : ""}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </details>
    </section>
  );
}

/** Small non-link badges for a node card (the card itself is a link). */
export function CodeBadges({ link }: { link: CodeLink | undefined }) {
  if (!link) return null;
  return (
    <>
      {link.code && (
        <span
          role="img"
          aria-label={`コードあり${link.code.stars ? `（GitHub ★${link.code.stars}）` : ""}`}
          title={`コード: ${link.code.url.replace("https://github.com/", "")}`}
          className="rounded bg-surface-2 px-1 text-[0.6rem] font-semibold text-ink-muted"
          data-badge="code"
        >
          コード{link.code.stars ? ` ★${compactCount(link.code.stars)}` : ""}
        </span>
      )}
      {link.hf && (
        <span
          role="img"
          aria-label={`Hugging Face: モデル ${link.hf.models} 件`}
          title={`Hugging Face Papers: ▲${link.hf.upvotes}・モデル ${link.hf.models}・データセット ${link.hf.datasets}・Space ${link.hf.spaces}`}
          className="rounded bg-surface-2 px-1 text-[0.6rem] font-semibold text-ink-muted"
          data-badge="hf"
        >
          HF
        </span>
      )}
    </>
  );
}

export function ThemeCodeLinksSection({
  links,
  nodes,
}: {
  links: ThemeCodeLinks | null;
  nodes: readonly LineageNode[];
}) {
  if (!links) return null;
  const rows = nodes
    .filter((n) => links[n.id])
    .map((n) => ({ node: n, link: links[n.id] as CodeLink }));
  if (rows.length === 0) return null;
  const usesHf = rows.some((r) => r.link.hf || r.link.code?.source === "huggingface-papers");
  return (
    <section
      aria-labelledby="code-links-heading"
      className="rounded-md border border-rule bg-surface"
      data-code-links
    >
      <details className="group p-4">
        <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
          <h2 id="code-links-heading" className="font-serif text-lg font-semibold text-ink">
            コードとモデル
          </h2>
          <span className="text-xs text-ink-subtle">
            {rows.length} 本
            <span aria-hidden="true" className="ml-2 group-open:hidden">
              開く ▾
            </span>
          </span>
        </summary>
        <ul className="mt-2 space-y-2 text-sm">
          {rows.map(({ node, link }) => (
            <li key={node.id}>
              <span className="text-ink">
                {typeof node.title === "string" ? node.title : node.id}
              </span>
              <span className="ml-2 inline-flex flex-wrap gap-2 text-xs">
                {link.code && (
                  <a
                    href={link.code.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-strong underline"
                  >
                    コード（GitHub{link.code.stars ? ` ★${compactCount(link.code.stars)}` : ""}）
                  </a>
                )}
                {link.hf && (
                  <a
                    href={link.hf.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-strong underline"
                  >
                    HF（モデル {compactCount(link.hf.models)}・データセット{" "}
                    {compactCount(link.hf.datasets)}・Space {compactCount(link.hf.spaces)}）
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-ink-subtle">
          {usesHf ? (
            <>
              リポジトリと件数は{" "}
              <a href="https://huggingface.co/papers" rel="noopener" className="underline">
                Hugging Face Papers
              </a>{" "}
              に登録された値です（取得日の値。HF の自動要約は使っていません）。
            </>
          ) : null}
          HF にリポジトリの登録がない論文は、PaperPilot が手作業で確認した対応表から表示します。
        </p>
      </details>
    </section>
  );
}
