import type { Metadata } from "next";
import Link from "next/link";
import { buildMetadata } from "../../lib/metadata";
import styles from "./how-it-works.module.css";

/**
 * Static port of docs/how-it-works/index.html (design doc §8 P2, the last
 * page in the plan's order). Server Component: this page has no state, so
 * `metadata` comes straight from here (a sibling layout.tsx is only needed
 * by Client Component pages).
 *
 * The Japanese copy is verbatim from the current page, including where its
 * source breaks lines -- JSX folds a line break into one space exactly like
 * HTML does, so the rendered text keeps the same spaces.
 *
 * Each relation row carries stroke shape + EN key + JP label + plain-JP
 * meaning next to its colour, and that colour comes from the shipped
 * `--rel-*` tokens, so the specimen IS the viewer's real edge colour and
 * colour is never the sole signal.
 */
export const metadata: Metadata = buildMetadata({
  path: "/how-it-works/",
  title: "仕組み — 線の色が示す《関係》 | PaperPilot",
  description:
    "PaperPilot の家系図で、色のついた線は論文どうしの「関係」を表します。置換・後継・拡張・成分分析・比較・対立の6種を、実際のエッジ色と意味で解説。",
  ogImage: {
    path: "/assets/og-image.png",
    width: 1200,
    height: 630,
    alt: "PaperPilot — AI/ML 論文の系譜（家系図）を可視化",
  },
});

interface RelationSpecimen {
  /** This relation's row modifier, which sets `--rel` (its real edge colour). */
  readonly rowStyle: string | undefined;
  /** Screen-reader description of the specimen: colour + stroke shape. */
  readonly sampleLabel: string;
  readonly stroke: string;
  readonly strokeWidth: string;
  readonly strokeDasharray?: string;
  readonly ja: string;
  readonly en: string;
  readonly meaning: string;
  /** `親 → 子`, the direction the site reads a lineage edge in. */
  readonly example?: { readonly from: string; readonly to: string };
}

const RELATIONS: readonly RelationSpecimen[] = [
  {
    rowStyle: styles.relRowSupersedes,
    sampleLabel: "深い金色の実線",
    stroke: "var(--rel-supersedes)",
    strokeWidth: "2.6",
    ja: "置換",
    en: "supersedes",
    meaning: "旧手法を置き換える「決定版」。同じ土俵で明確に上回り、以後はこちらが本流になる。",
    example: { from: "FlashAttention", to: "FlashAttention-2" },
  },
  {
    rowStyle: styles.relRowSuccessor,
    sampleLabel: "淡い金色の実線",
    stroke: "var(--rel-successor)",
    strokeWidth: "2.2",
    ja: "後継",
    en: "successor",
    meaning: "同じ系統を素直に受け継ぐ、次の世代。置換ほど決定的ではないが直系の続き。",
    example: { from: "A ConvNet for the 2020s", to: "ConvNeXt V2" },
  },
  {
    rowStyle: styles.relRowExtends,
    sampleLabel: "緑色の破線",
    stroke: "var(--rel-extends)",
    strokeWidth: "1.8",
    strokeDasharray: "7 4",
    ja: "拡張",
    en: "extends",
    meaning: "土台はそのままに、新しい能力や適用範囲を足す。手法を別ドメインへ広げる場合など。",
    example: { from: "Transformer", to: "Vision Transformer (ViT)" },
  },
  {
    rowStyle: styles.relRowAblation,
    sampleLabel: "青色の破線",
    stroke: "var(--rel-ablation)",
    strokeWidth: "1.6",
    strokeDasharray: "5 4",
    ja: "成分分析",
    en: "ablation",
    meaning:
      "構成要素を抜き差しして、どこが効いているかを測る検証的な関係。多くは論文内で行われるため、論文間のエッジとしては稀。",
  },
  {
    rowStyle: styles.relRowBaseline,
    sampleLabel: "灰色の点線",
    stroke: "var(--rel-baseline)",
    strokeWidth: "1.6",
    strokeDasharray: "2 4",
    ja: "比較",
    en: "baseline",
    meaning:
      "性能比較の「物差し」として引かれる対照。新手法が旧手法をベースラインとして引用するケース。最も弱い結びつき。",
  },
  {
    rowStyle: styles.relRowContrasts,
    sampleLabel: "赤色の一点鎖線",
    stroke: "var(--rel-contrasts)",
    strokeWidth: "1.6",
    strokeDasharray: "4 2 1 2",
    ja: "対立",
    en: "contrasts",
    meaning:
      "設計思想が真っ向から異なる、対抗する系統。同時代の別アプローチ（例: CNN と Transformer）どうしなど。",
  },
];

interface SeeAlsoLink {
  readonly icon: string;
  readonly href: string;
  readonly label: string;
}

const SEEALSO_LINKS: readonly SeeAlsoLink[] = [
  {
    icon: "📐",
    href: "https://github.com/taichiiiiiiii/automatic-paper-search/blob/develop/docs/design/39-typescript-cloudflare-migration.md",
    label: "設計とロードマップ（TypeScript / Cloudflare 構成）",
  },
  {
    icon: "✅",
    href: "https://github.com/taichiiiiiiii/automatic-paper-search/tree/develop/docs/migration",
    label: "移行と運用の記録",
  },
];

const PIPELINE_STEPS = ["収集", "絞り込み", "スコア", "関係分類", "家系図"] as const;

export default function HowItWorksPage() {
  return (
    <main id="main-content" tabIndex={-1} className={styles.page}>
      <header className={styles.hero}>
        <nav className={styles.breadcrumb} aria-label="breadcrumb">
          <Link href="/">PaperPilot</Link> &nbsp;/&nbsp; 仕組み
        </nav>
        <h1 className={styles.heroTitle}>
          色のついた線は、
          <wbr />
          <em>関係</em>です。
        </h1>
        <p className={styles.heroLede}>
          家系図のエッジは飾りではありません。
          <span className={styles.ledeStrong}>
            引用関係を分析して判定した、論文どうしの「関係の種類」
          </span>
          を、 色と線種で表しています。全6種の意味を、ビューアで実際に出る線そのもので解説します。
        </p>
      </header>

      <section aria-labelledby="rel-heading">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionHeadTitle} id="rel-heading">
            6つの関係
          </h2>
          <p className={styles.sectionHeadNote}>親 → 子（古い論文 → 新しい論文）の向きで読みます</p>
        </div>

        <ul className={styles.relList}>
          {RELATIONS.map((relation) => (
            <li
              key={relation.en}
              className={
                relation.rowStyle ? `${styles.relRow} ${relation.rowStyle}` : styles.relRow
              }
            >
              <svg
                className={styles.relRowEdge}
                viewBox="0 0 56 16"
                role="img"
                aria-label={relation.sampleLabel}
              >
                <line
                  x1="3"
                  y1="8"
                  x2="53"
                  y2="8"
                  stroke={relation.stroke}
                  strokeWidth={relation.strokeWidth}
                  strokeDasharray={relation.strokeDasharray}
                />
              </svg>
              <div className={styles.relRowHead}>
                <span className={styles.relRowJa}>{relation.ja}</span>{" "}
                <span className={styles.relRowKey}>{relation.en}</span>
              </div>
              <p className={styles.relRowMeaning}>{relation.meaning}</p>
              {relation.example ? (
                <p className={styles.relRowEg}>
                  例: <b>{relation.example.from}</b> → <b>{relation.example.to}</b>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.how} aria-labelledby="how-heading">
        <div className={`${styles.sectionHead} ${styles.sectionHeadBare}`}>
          <h2 className={styles.sectionHeadTitle} id="how-heading">
            どう判定しているか
          </h2>
        </div>
        <p className={styles.howBody}>
          論文を <strong>arXiv・Semantic Scholar・OpenAlex</strong>{" "}
          から収集し、品質シグナルで絞り込んだうえで、
          引用グラフ（どの論文がどれを引いているか）をたどります。各エッジの関係種別は、
          <strong>引用文脈や引用の意図、年代・引用数の関係を手がかりに自動判定</strong>し、
          曖昧なものは <strong>LLM</strong> が補助します（LLM
          が使えないときは決定的なヒューリスティックにフォールバック）。
          詳しい段階構成・スコアリングの正式な定義は、下記の設計ドキュメントを参照してください。
        </p>
        <ul className={styles.howSteps} aria-label="処理の流れ">
          {PIPELINE_STEPS.map((step, index) => (
            <PipelineStep key={step} label={step} arrow={index < PIPELINE_STEPS.length - 1} />
          ))}
        </ul>
      </section>

      <section className={styles.seealso} aria-labelledby="seealso-heading">
        <div className={`${styles.sectionHead} ${styles.sectionHeadBare}`}>
          <h2 className={styles.sectionHeadTitle} id="seealso-heading">
            さらに詳しく
          </h2>
          <p className={styles.seealsoNote}>
            実装の詳細は GitHub のドキュメントへ。<strong>いまの構成と今後の計画</strong>
            は設計書 39 番、切替と運用の経過は移行の記録にあります。
          </p>
        </div>
        <ul className={styles.seealsoLinks}>
          {SEEALSO_LINKS.map((link) => (
            <li key={link.href}>
              <a href={link.href} rel="noopener">
                <span aria-hidden="true">{link.icon}</span> {link.label}
              </a>
            </li>
          ))}
        </ul>
        <p>
          <Link href="/themes/" className={styles.guideCta}>
            系譜の公開準備状況を見る <span aria-hidden="true">→</span>
          </Link>
        </p>
      </section>
    </main>
  );
}

/** One `収集 → 絞り込み → …` chip; the arrow is decoration, not content. */
function PipelineStep({ label, arrow }: { label: string; arrow: boolean }) {
  return (
    <>
      <li>{label}</li>
      {arrow ? (
        <li className={styles.howArrow} aria-hidden="true">
          →
        </li>
      ) : null}
    </>
  );
}
