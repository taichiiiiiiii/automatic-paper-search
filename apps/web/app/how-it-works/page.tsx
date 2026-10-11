import type { Metadata } from "next";
import Link from "next/link";
import { buildMetadata } from "../../lib/metadata";
import {
  ISSUES_URL,
  NOTICE_URL,
  PRIVATE_REPORT_URL,
  TAKEDOWN_POLICY_URL,
} from "../../lib/site-links";
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
    "PaperPilot の家系図で、色のついた線は論文どうしの「関係」を表します。置換・後継・拡張・成分分析・参照（背景）・対立の6種を、実際のエッジ色と意味で解説。関係の根拠と出典・ライセンスも案内します。",
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
    ja: "参照（背景）",
    en: "baseline_only",
    meaning:
      "背景・関連研究として、または性能比較の物差し（ベースライン）として引用している関係。手法を受け継いだとまでは言えない、最も弱い結びつき。Semantic Scholar の引用文で「背景」「利用」「比較」と分類された引用の多くがここに入ります。",
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
    icon: "🧭",
    href: "https://github.com/taichiiiiiiii/automatic-paper-search/blob/develop/docs/design/41-lineage-publication-and-reliability.md",
    label: "系譜の公開段階と関係の根拠（設計書 41）",
  },
  {
    icon: "📐",
    href: "https://github.com/taichiiiiiiii/automatic-paper-search/blob/develop/docs/design/40-post-cutover-roadmap.md",
    label: "今後の計画（ロードマップ、設計書 40）",
  },
  {
    icon: "✅",
    href: "https://github.com/taichiiiiiiii/automatic-paper-search/blob/develop/docs/migration/p5-runbook.md",
    label: "運用の手順と記録",
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
          引用グラフ（どの論文がどれを引いているか）をたどります。各エッジの関係の種類は、主に
          <strong>
            Semantic Scholar が提供する引用文（本文で相手の論文に触れている 1
            文）と引用の意図（背景・手法の利用・結果の比較）、重要な引用かどうかの印
          </strong>
          から規則で判定します。引用文に「拡張する」「置き換える」などの手がかり語があるときだけ{" "}
          <strong>LLM</strong>{" "}
          が関係の種類を補助します。題名の版（「V2」など）や基礎文献リスト、引用と年からの推測で補う関係もあります。
          引用文に手がかりがないときは、新しい論文の要旨が相手の論文を名指しして「〜を基に」「〜と異なり」と述べている
          1 文も根拠にします（出典は「新しい論文の要旨」と表示します）。 Semantic Scholar
          に引用文がない組では、新しい論文の arXiv の HTML
          版の本文から引用文を取り、同じ規則で判定することがあります（出典は「arXiv
          HTML」と表示します）。
        </p>
        <p className={styles.howBody}>
          家系図の線をクリック（タップ、またはキーボードで選んで Enter）すると、
          <strong>判定の根拠・判定方法・確信度と、根拠になった引用文そのもの</strong>
          を表示します。グラフの下の「関係の一覧」でも同じ内容を確認できます。
        </p>
        <p className={styles.howBody}>
          公開するのは、<strong>自動検査（形式・識別子・関係の根拠）に合格した系譜</strong>
          だけです。人がテーマとの適合と強い主張の関係（置換・対立）を確認したものには
          <strong>「監査済み」</strong>、まだ確認していないものには
          <strong>「未監査（自動生成）」</strong>と表示します。
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
            実装の詳細は GitHub のドキュメントへ。<strong>公開段階と関係の根拠</strong>
            は設計書 41 番、いまの構成は設計書 39 番、切替と運用の経過は移行の記録にあります。
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
            公開中の系譜を見る <span aria-hidden="true">→</span>
          </Link>
        </p>
      </section>

      <section id="credits" className={styles.credits} aria-labelledby="credits-heading">
        <div className={`${styles.sectionHead} ${styles.sectionHeadBare}`}>
          <h2 className={styles.sectionHeadTitle} id="credits-heading">
            出典とライセンス
          </h2>
        </div>
        <ul className={styles.creditsList}>
          <li>
            参考文献・引用文脈（引用文）・引用の意図・重要な引用の印は{" "}
            <a href="https://www.semanticscholar.org/" rel="noopener">
              Semantic Scholar
            </a>{" "}
            のデータで、{" "}
            <a href="https://opendatacommons.org/licenses/by/1-0/" rel="noopener">
              ODC-BY 1.0
            </a>{" "}
            に基づいて利用しています。出典: Kinney et al., “The Semantic Scholar Open Data
            Platform”, 2023（
            <a href="https://arxiv.org/abs/2301.10140" rel="noopener">
              arXiv:2301.10140
            </a>
            ）。引用の意図の分類は Cohan et al., “Structural Scaffolds for Citation Intent
            Classification in Scientific Publications”, NAACL 2019 によります。
          </li>
          <li>
            根拠として表示する引用文は論文本文からの短い引用です。1 文・約 300
            字までにとどめ、引用符で囲み、出典「Semantic
            Scholar」と論文へのリンクを添えて表示します。本文や PDF の再配布はしません。
          </li>
          <li>
            論文の書誌情報の一部は{" "}
            <a href="https://openalex.org/" rel="noopener">
              OpenAlex
            </a>
            （CC0）を利用しています。OpenAlex に感謝します。
          </li>
          <li>
            学会カタログの要旨は、各学会の公開データから取得しています。
            <a href="https://openreview.net/" rel="noopener">
              OpenReview
            </a>
            （ICLR・ICML・NeurIPS）と arXiv の書誌情報（題名・著者・要旨）は CC0 です。
            <a href="https://aclanthology.org/" rel="noopener">
              ACL Anthology
            </a>
            （ACL・EMNLP）の論文は{" "}
            <a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener">
              CC BY 4.0
            </a>{" "}
            で、著作権は各著者にあります。
            <a href="https://openaccess.thecvf.com/" rel="noopener">
              CVF Open Access
            </a>
            （CVPR・ICCV）の論文は、著作権が著者に留保されています（ライセンスの付与なし）。要旨の全文は順次、掲載をやめます。
          </li>
          <li>
            Semantic Scholar に引用文がない組の引用文は、arXiv の HTML 版（
            <a href="https://arxiv.org/html/" rel="noopener">
              arxiv.org/html
            </a>
            ）の本文から 1 文だけ引用します（robots.txt の Crawl-delay を守って取得し、HTML
            は保存・再配布しません。論文のライセンスは論文ごとに異なります）。出版社が参考文献を
            Semantic Scholar に出していない論文は{" "}
            <a href="https://www.crossref.org/" rel="noopener">
              Crossref
            </a>{" "}
            の参考文献リストで引用の有無だけを補い、会議・論文誌の名前は{" "}
            <a href="https://dblp.org/" rel="noopener">
              dblp
            </a>
            （CC0）で補正することがあります。
          </li>
          <li>
            Thank you to{" "}
            <a href="https://arxiv.org/" rel="noopener">
              arXiv
            </a>{" "}
            for use of its open access interoperability. 本サイトは arXiv・Semantic
            Scholar・OpenAlex・OpenReview・ACL Anthology・CVF
            の公式サービスではなく、各団体の推奨・承認を受けたものでもありません。
          </li>
          <li>
            本サイトのプログラムは MIT ライセンスです。データは MIT
            の対象ではなく、それぞれの出典のライセンスに従います（
            <a href={NOTICE_URL} rel="noopener">
              NOTICE.md
            </a>
            ）。
          </li>
          <li>
            要旨・引用文の削除や訂正を希望する権利者・ご本人は、
            <a href={PRIVATE_REPORT_URL} rel="noopener">
              非公開の窓口
            </a>
            からご連絡ください（下の「プライバシーと削除依頼」）。系譜の誤りなど、公開してよい報告は{" "}
            <a href={ISSUES_URL} rel="noopener">
              GitHub の Issue
            </a>{" "}
            で受け付けています。
          </li>
        </ul>
      </section>

      <section id="privacy" className={styles.credits} aria-labelledby="privacy-heading">
        <div className={`${styles.sectionHead} ${styles.sectionHeadBare}`}>
          <h2 className={styles.sectionHeadTitle} id="privacy-heading">
            プライバシーと削除依頼
          </h2>
        </div>
        <ul className={styles.creditsList}>
          <li>本サイトは個人が運営する非営利のサイトです。扱う情報と目的は次のとおりです。</li>
          <li>
            テーマの依頼：入力したテーマ名は、生成の処理に渡され、結果とともに GitHub
            の公開リポジトリに残ります。誰でも見られるので、個人名などの個人情報は入力しないでください。
          </li>
          <li>
            IP アドレス：テーマ依頼の回数制限（乱用の防止）のため、依頼を送った IP アドレスを
            API（Cloudflare Workers）に保存し、約 1 時間で削除します。
          </li>
          <li>
            アクセスの記録：サイトと API は Cloudflare（米国）で動いています。Cloudflare
            は配信と障害の調査のため、IP アドレスなどを含むアクセスの記録を処理します。API
            のログは最大 7 日で消えます。
          </li>
          <li>
            Cookie
            と解析：Cookie、アクセス解析、広告のタグは使っていません。表示の設定（系譜の表示方法など）だけを、お使いのブラウザの
            localStorage に保存します。この設定はサーバーに送りません。
          </li>
          <li>
            著者名：論文の検索と系譜の表示のため、公開されている書誌データ（arXiv・OpenReview・ACL
            Anthology・CVF・Semantic
            Scholar・OpenAlex）にある著者名を載せています。所属やメールアドレスは載せていません。
          </li>
          <li>
            削除・訂正の依頼：権利者・ご本人は、
            <a href={PRIVATE_REPORT_URL} rel="noopener">
              非公開の窓口（GitHub の「Report a vulnerability」）
            </a>
            からご連絡ください。内容は運営者だけが読めます。受付から 3
            営業日以内を目安に、該当の表示をいったん止め、確認のうえ対応します（
            <a href={TAKEDOWN_POLICY_URL} rel="noopener">
              手順
            </a>
            ）。いまは GitHub のアカウントが必要です。メールの窓口は準備中です。
          </li>
        </ul>
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
