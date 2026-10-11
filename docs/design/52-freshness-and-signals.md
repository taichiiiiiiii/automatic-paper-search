# 52 鮮度と注目度のシグナル：新着論文・学会の新しい回を LLM なしで見つける（2026-10-11 調査）

対象：collect（新着の収集）、R3（学会の新しい回を見つけ、承認 1 回で一覧に載せる）、人気度の順位づけ。
方法：リポジトリの読解（読み取りのみ）、公式ドキュメント、少量の実 API 呼び出し（2026-10-11 JST）。生の応答は `手元の一時領域の probe52/` に置いた。
前提：LLM は使わない。上流サービスが LLM で作った項目（HF の `ai_summary` など）は、表示にも判定の中心にも使わない。
この文書は法的助言ではない。規約は「公式の文言＋推奨する対応」にとどめる。

---

## 0. 結論（先に）

1. **R3 の土台にしている OpenReview の `/notes` は、いま機械からは読めない**。`api2.openreview.net/notes` と v1 の `/notes` は、どの条件で呼んでも **403 `ChallengeRequiredError`（Challenge verification required）** を返した。`watch/openreview.ts`（`conference-sources-v1.yaml` の ICLR）と `conference/openreview/fetchNotes.ts` はどちらもこの経路を使っているので、**このままでは R3 も、ICLR・NeurIPS・ICML の一覧の作り直しも動かない**。
   - `/groups` は今も読める（会場 ID、開催日、採否ラベル）。新しい回が「できた」ことは分かるが、採択論文の一覧は取れない。
   - 第三者の報告（Pipeworx、2026-09-01 検証）では「トークンの有無に関係なく 403」。こちらでは未検証（アカウントが要る）。
2. **公式サイトの「virtual site」の JSON（miniconf 形式）が最も早く、最もそろっている**。`neurips.cc/static/virtual/data/neurips-2026-orals-posters.json` は 2026-10-11 の時点で 9,242 件（oral 316 / spotlight 329 / poster 8,445）。同じ形式で ICML 2026（6,797 件）、ICLR 2026（5,691 件）、ECCV 2026（2,997 件）が取れた。どれにも採否のラベルと OpenReview の forum URL が付いている。
   - **ただし 4 サイトとも robots.txt に `Disallow: /static` がある**。定期的な自動取得の前に、主催者への確認が要る（§3.2、決定事項 D1）。
3. **正式な proceedings 系の情報源は機械可読で、規約も明確**。PMLR（ICML 2026 = Volume 306、6,552 本）、ACL Anthology（GitHub の XML、CC BY 4.0）、CVF Open Access、AAAI の OJS（OAI-PMH が動く）、DBLP（**SPARQL とダンプは動くが、検索 API と HTML はボット判定のページを返した**）。いずれも virtual site より数週〜数か月遅いが、確定版として使える。
4. **S2 と OpenAlex の会場情報は大きく遅れる**。S2 の `venue=… year=2026` は NeurIPS で 92 本、ICML で 22 本だった（実際は約 6,500〜9,000 本）。**新しい回の検知には使えない**。論文 ID の照合と被引用数のためだけに使う。
5. **掲載が遅れている回がすでにある**。サイトには 10 回分しかない。一方で、ICML 2026、NeurIPS 2026、ACL 2026、ECCV 2026（さらに COLM 2026・EMNLP 2026・AAAI 2027 がこれから）は、公式の一覧がもう出ているか、まもなく出る。R3 の前に手作業で 1 回追いつく価値がある。
6. **人気度の主力は HF Daily Papers と GitHub の★**。HF の API は鍵なしで動き（実測：`api` 枠 500 回/5 分）、`upvotes`・`githubRepo`・`githubStars`・`numComments` が付いている。Papers with Code は 2025-07 に終了したので、論文とコードの対応づけは HF の `githubRepo` が代わりになる。
   - ★は一時点の値ではなく、毎週の記録から**増え方（Δ★/週）**を計算して使う。
   - SNS では HN（Algolia、鍵なし）と Mastodon（鍵なし）は使える。Bluesky の検索は鍵なしでは 403、Reddit は OAuth 必須、Altmetric は公開表示が有償なので、**優先度は低い**。
7. **日本語のシグナル**：はてなブックマークの件数 API（鍵なし。「Attention Is All You Need」の arXiv URL で 50 件）と Zenn・Qiita の記事は、「日本語圏で話題か」の補助シグナルになる。J-STAGE WebAPI では JSAI 2026（1,376 件、日本語題目付き）が取れるので、日本語サイトとして独自の価値を出す候補になる。

---

## 1. PaperPilot の現状（関係する部分だけ）

| 領域 | 今の実装 | 状態 |
|---|---|---|
| collect の情報源 | `collect/sources/arxiv`（`export.arxiv.org/api/query`）、`s2.ts`、`openalex.ts`（`enabled: false`） | cron は 2026-06 から停止（40） |
| collect のシグナル | `signals/github.ts`：手作業の対応表（`paper_repos.json`）→ GitHub のリポジトリ検索 → ★ を対数で 0〜100 に換算。ほかに venue / citation / author / follow / keyword | 鍵なしの検索は 10 回/分（実測の `x-ratelimit-limit: 10`） |
| 学会の取り込み | `conference/openreview`（api2 `/notes`）、`cvf`、`acl`（GitHub XML）、`arxiv`（`co:"NeurIPS 2026"` のようなコメント検索）、`scaffold` | `conference-on-demand.yml` は arXiv のコメント検索を手動で起動するもの |
| 新しい回の検知（R3） | `conference/watch/*`（openreview-v2 アダプタ、安定性・件数ゲート・dry-run） | `conference-sources-v1.yaml` は `apply_enabled: false`、ICLR だけを `enabled: false` で登録 |
| 公開中の回 | aaai-2026, acl-2025, cvpr-2025/2026, eccv-2024, emnlp-2025, iccv-2025, iclr-2026, icml-2025, neurips-2025 | **arXiv 以外から作った 8 回は `arxiv_id` も `github_stars` も 0 件**。人気度の順位づけに使える材料が無い |

---

## 2. 実測（2026-10-11 JST、少量の呼び出し）

| 対象 | 結果 |
|---|---|
| OpenReview `api2 /notes`（`content.venueid=NeurIPS.cc/2026/Conference`、`id=…`、v1 の `/notes`） | すべて **403 `ChallengeRequiredError`** |
| OpenReview `/groups?id=venues` | 200。会場 ID 4,768 件。`NeurIPS.cc/2026/Conference`、`ICLR.cc/2027/Conference`、`ICML.cc/2026/Conference`、`aclweb.org/ACL/2026/Conference`、`EMNLP/2026/Conference`、`thecvf.com/ECCV/2026/Conference`、`colmweb.org/COLM/2026/Conference`、`aistats.org/AISTATS/2027/Conference` を含む |
| OpenReview `/groups?id=NeurIPS.cc/2026/Conference` | `start_date: Dec 06 2026`、`accept_decision_options`、`decision_heading_map` が取れる。ICLR 2027 は `start_date` が 2027-04-26（UTC）で、投稿受付は終了（invitation expired） |
| OpenReview `/notes/search?term=…&venueid=…` | 200 だが 0 件。会場ごとの一覧には使えない |
| virtual site の miniconf JSON | NeurIPS 2026：9,242 件、ICML 2026：6,797 件、ICLR 2026：5,691 件、ECCV 2026：2,997 件、CVPR 2026：200 件（不完全）、ICLR 2027：0 件。項目は `name, authors(+institution), topic, keywords, decision, eventtype, paper_url(OpenReview forum), poster_position`。**要旨は入っていない** |
| robots.txt | neurips.cc / icml.cc / iclr.cc / eccv.ecva.net / cvpr.thecvf.com：いずれも `User-agent: * Disallow: /static` |
| PMLR | 一覧の先頭付近に「Volume 306 Proceedings of ICML 2026」。`/v306/` には 6,552 本。GitHub の `mlresearch/v306` に BibTeX がある（v267 = ICML 2025 は 2025-10-06 に公開） |
| papers.nips.cc | 最新は NeurIPS 2025（2026 年分はまだ無い） |
| CVF Open Access `/menu` | CVPR 2026（2026-05-23 公開）、WACV 2026、ICCV 2025 |
| ECVA papers.php | 最新は ECCV 2024。2026 年分はまだ無い |
| ACL Anthology | `events/acl-2026`・`eacl-2026` があり、`2026.acl.xml`（GitHub raw）は 200。EMNLP 2026 はまだ無い。フッターのライセンスは CC BY 4.0 |
| AAAI OJS の OAI-PMH | `ojs.aaai.org/index.php/AAAI/oai?verb=Identify` は 200、ListSets も動く |
| DBLP | `search/publ/api` と `db/…xml` は **「Making sure you're not a bot!」（Anubis）の HTML** を返した。`sparql.dblp.org` は 200（NeurIPS 2025 = 5,824 件、7 ms）。`dblp.xml.gz`（1.1 GB）も取得できる |
| arXiv | RSS（`rss.arxiv.org/rss/cs.LG`）は 200 だが日曜は空（`skipDays` が土日）。OAI-PMH（`oaipmh.arxiv.org`、`set=cs`、1 日分）は 0.4 秒で 1,300 件 / 1 ページ。`set=cs:cs:LG` を指定すると 40 秒でタイムアウトした |
| arXiv のコメント欄（2026-10-09 の cs、1,300 件） | 645 件にコメントあり。会場名＋年の言及は NeurIPS 2026 が 56、EMNLP 2026 が 17、ICLR 2027 が 6（ほとんどは「under review」の段階）、ICML 2026 が 4 |
| S2 `search/bulk?venue=…&year=2026` | NeurIPS 92 件、ICML 22 件、ECCV 5 件。**会場の情報が大きく遅れている**。鍵なしでは 429 が出る（再試行で 200） |
| HF Daily Papers `api/daily_papers` | 200、鍵なし。`ratelimit-policy: "fixed window";"api";q=500;w=300`。検索は `q=50;w=300`。項目は `upvotes, githubRepo, githubStars, numComments, projectPage, organization, submittedOnDailyAt`。`ai_summary`・`ai_keywords` は LLM（Qwen）の生成 |
| HF `api/papers/2205.14135` | `upvotes`、`numTotalModels: 338`、`numTotalSpaces: 2268`、`linkedModels/Datasets` |
| GitHub の検索（鍵なし） | `x-ratelimit-limit: 10`（search 枠、1 分あたり） |
| HN Algolia | 200、鍵なし。arXiv の URL で検索すると points と num_comments が取れる。上限は 1 IP あたり 1 万回/時（公式） |
| Bluesky `public.api.bsky.app … searchPosts` | **403** |
| Mastodon（sigmoid.social の `timelines/tag/arxiv`） | 200、鍵なし。`x-ratelimit-limit: 300`（5 分ごと） |
| はてなブックマーク `bookmark.hatenaapis.com/count/entries` | 200、鍵なし。1706.03762 → 50、2205.14135 → 0 |
| Zenn `zenn.dev/api/articles?topicname=llm&order=daily` | 200（非公式 API）。`liked_count`・`bookmarked_count` |
| Qiita API v2 | 200。上限は鍵なしで 60 回/時、トークンありで 1,000 回/時（公式） |
| J-STAGE WebAPI | 200、鍵なし。`cdjournal=pjsai`（JSAI 全国大会）の 2026 年分は 1,376 件で、英語・日本語の題目付き |

---

## 3. 情報源ごとの評価

記号：◎ 主力 / ○ 補助 / △ 条件付き / × 使わない。

### 3.1 新着論文（collect）

| 情報源 | 取得方法・制限 | 規約・ライセンス | 信頼性 | PaperPilot での使い方 | 評価 |
|---|---|---|---|---|---|
| **arXiv OAI-PMH**（`oaipmh.arxiv.org/oai`） | `ListRecords&metadataPrefix=arXiv&set=cs&from=…`。毎晩、公開の直後に更新される。2025-03 に作り直されたため、旧 URL の `export.arxiv.org/oai2` は新しい URL を案内する。旧来の API 群（OAI・RSS・API）は**合わせて 3 秒に 1 回、同時接続 1** まで | 「Metadata for arXiv articles may be reused in non-commercial and commercial systems」（OAI のヘルプ）。本文 PDF を自前のサーバーに置いて配るのは禁止（API ToU） | 高い。公開日に網羅的。コメント欄（`comments`）・`journal-ref`・カテゴリ・ライセンスが付く | 週次の collect の母集団。今の `api/query`（キーワード検索）を「その週の cs.LG/CV/CL/AI の全件を OAI で取得 → ローカルで bge-small を当てる」に変えると、取りこぼしが減る（46 の Stage 3 と組み合わせる） | ◎ |
| arXiv RSS / Atom（`rss.arxiv.org/rss/cs.LG`） | 毎日の発表分だけ。土日は空。上限は上と同じ | 同上 | 高い（ただし当日分だけ） | 日次の daily-watch。cross-list・replace の区別付き | ○ |
| arXiv API（`export.arxiv.org/api/query`） | 検索。3 秒に 1 回 | 同上 | 中程度（検索順と件数上限の癖） | 今の実装。OAI に切り替えた後はキーワード検索の補助として残す | ○ |
| HF Daily Papers（`/api/daily_papers?date=YYYY-MM-DD`、`sort=trending`） | 鍵なし。500 回/5 分 | HF の利用規約。上限は公式の rate-limits ページにあり、変わりうる | 中〜高。人が投稿・推薦した「注目論文」の短いリスト（1 日 10〜50 本程度）。偏り（大手研究所・LLM 系）がある | collect の候補追加（「話題の論文」枠）。人気度の主シグナル（§3.3） | ◎（シグナル）／○（候補） |
| S2 Recommendations / `search/bulk` | 46・44 のとおり | ODC-BY・帰属表示 | 論文の近さには強い。会場の情報は遅れる | 手本論文に近い新着の追加（46 §2.1 C） | ○ |
| OpenAlex（`from_publication_date`） | 無料キーで 1 日 1 万 credits | CC0 | arXiv の取り込みは数日遅れる | 新着の検知には不要。keywords・topics の補完（46）だけ | △ |
| alphaXiv | 非公式の API 一覧はあるが、鍵が要り、規約は未確認 | 未確認 | — | 使わない（HF で足りる） | × |

### 3.2 学会の新しい回（R3）

検知は「(a) 回が存在する → (b) 採択一覧が出た → (c) 件数が安定した → (d) 確定版の proceedings」の 4 段階で考える。どの情報源がどの段階を担えるかを示す。

| 情報源 | 段階 | 取得方法・制限 | 規約 | 信頼性・注意 | 評価 |
|---|---|---|---|---|---|
| **OpenReview `/groups`** | (a)、採否ラベルの形 | 鍵なしで読める（2026-10-11）。`/groups?id=venues` の members と、各会場の `content`（`start_date`、`accept_decision_options`、`decision_heading_map`） | OpenReview Terms of Use（メタデータの定義あり。再利用の条件を明示したライセンス条項は見当たらない → 論文一覧の再配布は各回の慣行に従う） | 回の存在と、採否ラベルの名前（例：`Accept (oral)`）が事前に分かる。**一覧は取れない** | ◎（a） |
| OpenReview `/notes` | (b)(c) | **403 ChallengeRequiredError**。ログインすれば通るかは未検証。第三者の報告では通らない | — | 今の `watch/openreview.ts` と `fetchNotes.ts` はここで止まる | △（要検証） |
| **virtual site の miniconf JSON**（`{neurips,icml,iclr}.cc`・`eccv.ecva.net`・`cvpr.thecvf.com` の `/static/virtual/data/<conf>-<year>-orals-posters.json`） | (b)(c) | 1 回で全件（8〜27 MB）。`count` だけ見るなら毎日 1 回で足りる | **robots.txt の `Disallow: /static` が明示されている**。主催者のサイトの利用規約には個別の API 条項が無い | 最も早い（NeurIPS 2026 は開催 2 か月前に 9,242 件）。採否ラベル・OpenReview の forum URL・分野（`topic`）付き。要旨は無い。CVPR は不完全（200 件）だった | ◎ ただし **D1（許可）次第**。許可が出るまでは「人が手で 1 回取得して dry-run に渡す」入力として扱う |
| **PMLR**（`proceedings.mlr.press`、GitHub `mlresearch/vNNN`） | (d)（ICML・AISTATS・CoRL など） | 一覧のページで新しい Volume を検知 → GitHub の BibTeX（`vNNN.bib`）。負荷は小さい | 論文のライセンスは各論文に従う。メタデータの再利用で問題になった例は無い（規約の明文は未確認） | ICML 2026 = v306（6,552 本）。会期中〜会期後に出る。要旨・PDF・OpenReview への対応付きの版もある | ◎（ICML の確定版） |
| papers.nips.cc | (d) | 年ごとの HTML | — | 遅い（2025 年分の公開も遅れたとの声がある。2026 年分はまだ無い） | ○ |
| **CVF Open Access**（`/menu`、`/CVPR2026`） | (b)(d) | 今の `conference/cvf` アダプタ。`/menu` の「Published: …」で新しい回を検知できる | CVF の open access 版（透かし以外は最終版と同一、という表記） | 高い。CVPR・ICCV・WACV を網羅。ECCV は含まない | ◎ |
| ECVA（ECCV） | (d) | `ecva.net/papers.php` | — | 2026 年分は未公開。それまでは virtual site か arXiv のコメントで | ○ |
| **ACL Anthology**（GitHub の `data/xml/<year>.<venue>.xml`、`acl-anthology` の Python パッケージ） | (d)（ACL・EMNLP・NAACL・EACL・COLING・TACL） | 今の `conference/acl` アダプタ（GitHub raw）。GitHub の commits API で新しい XML を検知できる | メタデータは CC BY 4.0（サイトのフッター） | 高い。ACL 2026 は公開済み、EMNLP 2026 は未公開 | ◎ |
| **AAAI OJS の OAI-PMH**（`ojs.aaai.org/index.php/AAAI/oai`） | (d) | OAI-PMH の標準形。set は号ごと | OJS の論文ごとのライセンス | AAAI 2026 は arXiv 経由（762 本）で作っているので、こちらに切り替えれば網羅性が上がる | ○ |
| **DBLP** | (c)(d) の照合 | **検索 API と HTML はボット判定（Anubis）に入った**。SPARQL（`sparql.dblp.org`）とダンプは動く。429 なら `Retry-After` に従うよう FAQ に記載 | CC0 | 確定版が出た後に載る（数週〜数か月遅れる）。件数の検算（例：NeurIPS 2025 = 5,824 件 vs 公開中 5,286 件）に使える | ○（検算） |
| arXiv のコメント欄（OAI の `comments`） | (b) の早期の兆し | 上の OAI と同じ | 同上 | 「Accepted to NeurIPS 2026」が 1 日に数十件出る。「under review」「submitted to」を除く規則が要る。網羅率は 1〜3 割程度（今の `conference-on-demand` が使っている方式） | ○（兆し・補完） |
| ccf-deadlines（GitHub の YAML） | 開催日の予定 | 有志が管理する YAML | MIT（リポジトリ） | 「いつごろ採択一覧が出るか」の見張りの時期を決める入力。誤りもありうる | ○ |
| S2・OpenAlex の会場の項目 | — | — | — | NeurIPS 2026 が 92 件。**検知には使わない**。論文 ID の照合（題目 → arXiv ID・S2 ID）にだけ使う | ×（検知）／◎（照合） |

### 3.3 人気度・注目度

| 情報源 | 取れる値 | 制限 | 規約 | 偏り・信頼性 | 評価 |
|---|---|---|---|---|---|
| **HF Papers**（`/api/papers/{arxiv}`、`/api/daily_papers`） | `upvotes`、`numComments`、`githubRepo`、`githubStars`、`numTotalModels/Datasets/Spaces` | 鍵なしで 500 回/5 分（`api` 枠）。検索は 50 回/5 分 | HF の利用規約 | LLM・CV・大手研究所に偏る。Daily Papers に載らない論文は upvote が 0 のまま。**`ai_summary`・`ai_keywords` は LLM の生成なので使わない** | ◎ |
| **GitHub REST** | `stargazers_count`、`pushed_at`、`forks_count` | 鍵なし：60 回/時、検索 10 回/分。トークンあり：5,000 回/時、検索 30 回/分。Actions の `GITHUB_TOKEN` は 1 リポジトリあたり 1,000 回/時 | GitHub の利用規約 | ★は累積値なので古い論文が有利。**毎週の記録から Δ★ を出す**。リポジトリの特定は HF の `githubRepo` → 手作業の対応表 → 検索の順にすると、検索の枠をほとんど使わずに済む | ◎ |
| GitHub Trending | 当日・週の急上昇 | 公式の API は無い（HTML のスクレイピングだけ） | — | 論文との対応が取りにくい | × |
| **Hacker News（Algolia）** | `points`、`num_comments`（URL・題目で検索） | 鍵なし、1 IP あたり 1 万回/時 | 明示の再配布条項は無い。数値だけ使い、本文は載せない | 実務・システム系に偏る。多くの論文は 0 | ○ |
| **Mastodon**（sigmoid.social などの `timelines/tag/…`、`api/v2/search`） | 投稿数、boost・fav | 鍵なしで 300 回/5 分（サーバーごと） | サーバーごとの規約 | ML 研究者の一部だけ。量は少ない | △ |
| Bluesky | 投稿数、like・repost | `public.api.bsky.app` の `searchPosts` は 403。認証（アプリパスワード）すれば検索できる。全件の流れ（Jetstream）は鍵なしだが、常駐するプロセスが要る | AT Protocol の開発者規約 | 研究者の移行先として増えている。ただし Actions の定期実行とは相性が悪い | △（後回し） |
| Reddit（r/MachineLearning） | score、comments | OAuth 必須。無料枠は 1 client id あたり 100 QPM。認証しない通信は遮断される | Data API Terms（商用・ML 学習は別契約） | 量は中程度。登録の手間と規約の重さに見合わない | × |
| Altmetric | 総合スコア、言及 | API は鍵必須。無料枠は研究目的の一時利用だけで、公開表示は有償契約 | 帰属表示と申請が必要 | 公開サイトでの表示はできない | × |
| X（Twitter） | — | 有償 | — | — | × |
| **S2 `citationCount`・`influentialCitationCount`** | 被引用数 | 46・44 のとおり | ODC-BY・帰属表示 | 新着ではほぼ 0。会議の回が出てから半年後の順位づけに効く。**毎週の記録から増え方（velocity）を自前で計算する**（S2 の citationVelocity は今の API には無い） | ◎（時間がたった後） |
| OpenAlex `cited_by_count`・`counts_by_year` | 被引用数・年ごとの推移 | 無料キー | CC0 | S2 の検算 | ○ |
| 採否のランク（oral / spotlight） | 主催者の評価 | 一覧と一緒に取れる | — | 新しい回の時点で使える唯一の「質」の信号 | ◎（会議一覧） |

### 3.4 日本語の情報源

| 情報源 | 取れる値 | 制限・規約 | 使い方 | 評価 |
|---|---|---|---|---|
| **はてなブックマーク件数 API**（`bookmark.hatenaapis.com/count/entries?url=…&url=…`） | URL ごとのブックマーク数（複数の URL を 1 回で） | 鍵なし。公式 API | arXiv の abs・pdf、HF Papers、GitHub の URL の合計を「日本語圏での注目度」として加える | ◎（日本語の補助） |
| **Zenn**（`zenn.dev/api/articles?topicname=…&order=daily`） | 記事、`liked_count`、`bookmarked_count` | **非公式**（「zenn.dev 向けなので告知なく仕様が変わる」と運営が明言）。page 100 で打ち切り。頻度は控えめに | 記事の本文から arXiv ID・URL を正規表現で抜き出し、「この論文を解説した日本語記事」として紐づける（表示はリンクだけ） | ○ |
| **Qiita API v2**（`/api/v2/items?query=…`） | 記事、`likes_count`、`stocks_count` | 公式。鍵なしで 60 回/時、トークンありで 1,000 回/時 | 同上（`body` から arXiv の URL を抜き出す。週 1 回、タグ「機械学習」「論文読み」など） | ○ |
| **J-STAGE WebAPI** | 論文のメタデータ（日本語・英語の題目、著者、巻号） | 鍵なし。**利用規約への同意が前提。JST 提供の旨とリンクの表示が必要。商用利用は申請が必要。大量ダウンロードは不可** | JSAI 全国大会（`pjsai`）などを「日本の学会」として一覧にする候補（R5 の拡張） | ○（R5） |
| CiNii Research OpenSearch | 国内の論文・博士論文 | アプリケーション ID の登録が必要 | 国内の著者の名寄せ程度。優先度は低い | △ |

---

## 4. R3（新しい回を承認 1 回で一覧に載せる）への組み込み案

### 4.1 OpenReview が読めないことへの対応（最優先）

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A. 検知と一覧の取得を分ける（推奨）** | (a) は OpenReview の `/groups` で検知する。(b)(c) は virtual site の JSON（許可が出た場合）か、確定版（PMLR・CVF・Anthology・OJS）で取る。OpenReview の forum ID は virtual site の `paper_url` から取る | OpenReview の challenge に依存しない。ID の形（`openreview:<forum>`）は今の識別子のまま | virtual site の JSON は D1 の許可が前提。要旨は別途、S2 の `search/match`（題目）か OpenReview の Web で補う |
| B. 認証付きの OpenReview クライアント | ユーザーのアカウントで token を取り、Secret に登録して `/notes` を呼ぶ | 今のアダプタがほぼそのまま動く（要旨・採否が 1 回で取れる） | **challenge が token で外れるかは未検証**（第三者の報告では外れない）。Secret の管理と期限切れ。個人アカウントで機械取得するのは規約上も避けたい |
| C. arXiv のコメント欄＋S2 | 今の `conference-on-demand` の方式 | 鍵が要らない | 網羅率が 1〜3 割で、採否ラベルも無い。一覧としては不完全 |
| D. OpenReview に問い合わせる | 研究目的の読み取りに例外を認めてもらえるか | 正攻法 | 時間がかかる |

推奨：**A を既定にし、B は 1 回だけ検証する**（ユーザーのアカウントで `/notes?limit=1` が 200 になるか。token は Secret に入れ、会話には出さない）。D は並行して出す。

### 4.2 状態遷移（`conference/watch` を拡張）

```
unseen ──(groups に会場 ID が出る / CVF の menu に行が出る / Anthology に XML が出る / PMLR に Volume が出る)──▶ announced
announced ──(一覧の件数 > 0)──▶ decisions_out
decisions_out ──(件数が 6〜48h のあいだ変わらない：今の stability.ts と同じ)──▶ stable
stable ──(件数ゲート：最低件数、前回比 0.70〜1.50：yaml の count_gate)──▶ candidate
candidate ──(dry-run の差分と、作った成果物を Issue / PR にまとめる)──▶ 承認待ち
承認待ち ──(1 回の承認：PR のマージ、または environment の reviewer の承認)──▶ published
published ──(確定版の proceedings が出たら 1 回だけ照合し、件数の差を記録)──▶ reconciled
```

- 見張る頻度：`ccf-deadlines` の開催日から「採択の発表が見込まれる期間」（例：開催の 3 か月前〜開催日）だけ 1 日 1 回、それ以外は週 1 回。yaml の `active_months_utc` と同じ考え方で、自動で決める。
- 承認 1 回：`conference-on-demand.yml` を「watch が作った candidate の成果物を、そのまま promote する」流れに変える。人がフォームに値を入れる手間（`venue`、`query`、`display`、`lede`）を無くす。表示名と lede は yaml の `display_template` と定型文で作る（LLM は使わない）。
- 情報源の優先度は、回ごとに yaml へ書く（`adapter: miniconf | pmlr | cvf | acl-xml | aaai-oai | openreview-v2`）。確定版が出たら、確定版のアダプタに切り替える。

### 4.3 回ごとの割り当て案（2026-10 時点）

| 回 | いま取れる情報源 | 推奨 |
|---|---|---|
| ICML 2026 | PMLR v306（6,552）、virtual（6,797） | **PMLR**（確定版。今すぐ作れる） |
| NeurIPS 2026 | virtual（9,242）。papers.nips.cc はまだ | virtual（D1 の許可を得て）→ 後で papers.nips.cc と DBLP で照合 |
| ACL 2026 | Anthology（GitHub XML） | 今の `acl` アダプタで作れる |
| ECCV 2026 | virtual（2,997）。ECVA はまだ | virtual（D1）または ECVA の公開を待つ |
| EMNLP 2026・COLM 2026 | OpenReview の group はある。Anthology はまだ | 公開を待つ（EMNLP は Anthology の XML、COLM は virtual か OpenReview） |
| AAAI 2027 | 2027-02 | OJS の OAI-PMH（arXiv 経由より網羅的） |
| ICLR 2027 | group はある（開催 2027-04 下旬）。virtual はまだ 0 件 | 2027-01 下旬から見張る。採択一覧は virtual か、OpenReview（B が通れば） |

---

## 5. 人気度の順位づけ（LLM なし）

### 5.1 特徴量と記録

- **毎週の記録**（`data/state/signals/<yyyy-ww>.json`）に、arXiv ID ごとの `hf_upvotes`、`github_stars`、`hn_points`、`s2_citations`、`hatena_count` を残す。増え方（Δ/週）は差分で出す。被引用数の増え方も S2 から取れないので、この記録から作る。
- 会議一覧の論文には、まず **arXiv ID を付ける**。題目で S2 の `/paper/search/match` か OpenAlex に照合し、batch で `externalIds.ArXiv` を取る。一致の判定は「題目の正規化後に完全一致、または bge-small の cos ≥ 0.95 かつ第 1 著者が一致」。いま 8 回分の `arxiv_id` が空なので、これが無いと HF・HN・はてなが引けない。
- リポジトリ：HF の `githubRepo` → `paper_repos.json` → GitHub 検索（題目の類似度が高いものだけ）の順。検索の枠（30 回/分）は最後の手段にする。

### 5.2 合成の方法

- 同じ集団（同じ回、または同じ週の collect）の中で、各特徴量を `log1p` してから**パーセンタイル順位**にし、重み付きで平均する。値が無い特徴量は、その論文の重みの合計から外す（0 として罰しない）。どの特徴量を何個使ったかの「網羅数」を保存する。
- 重みの初期案：新しい回の時点では oral/spotlight 0.3、HF upvotes 0.25、Δ★ 0.25、HN 0.1、はてな 0.1。半年後からは被引用数の増え方を 0.3 にして、ほかを縮める。重みは R4 の固定クエリ評価（precision@k）で調整する。
- 表示：46 の「理由の定型文」と同じ形で根拠を出す（例：「HF ▲142／★1.2k（+310/週）／oral／はてブ 35」）。数値はすべて出典にリンクする。
- 操作への耐性：1 つのシグナルだけで上位 5% に入った論文には、「単一シグナル」の印を付ける。★の急増は、リポジトリの作成日とあわせて確認する。

---

## 6. 優先順位付きの提案

| 優先 | 提案 | 効くところ | 工数 | 外す LLM の役割・依存 | 前提・決定 |
|---|---|---|---|---|---|
| **P0** | OpenReview の challenge を `watch`・`openreview` アダプタで明示的なエラーとして扱う（`ChallengeRequiredError` → `source_blocked`。件数 0 を「縮んだ」と誤判定しない） | R3・学会の作り直し | 小 | — | なし |
| **P0** | ICML 2026 を PMLR v306 から、ACL 2026 を Anthology から、手動で 1 回作る（PMLR アダプタは BibTeX を読むだけの新規実装） | 鮮度（サイトの見た目にすぐ効く） | 小〜中 | — | 公開の承認（いつもの手順） |
| **P0** | OpenReview の `/groups` での回の検知（unseen → announced）を `watch` に足し、`conference-sources-v1.yaml` に NeurIPS・ICML・ICLR・COLM・EMNLP の行を加える | R3 (a) | 小 | — | なし |
| **P1** | miniconf の JSON アダプタ（`count` の監視 → 安定 → dry-run）。forum ID・採否・分野を取り、要旨は S2 で補う | R3 (b)(c)、NeurIPS 2026・ECCV 2026 | 中 | — | **D1**（主催者の許可、または手動で 1 回取る運用） |
| **P1** | 会議一覧への arXiv ID の付与（S2 の search/match と batch、OpenAlex で検算） | 人気度・系譜・HF との結合 | 中 | — | なし（S2 は鍵なし、OpenAlex は無料キー） |
| **P1** | HF Papers のシグナル（`upvotes`・`githubRepo`・`githubStars`）を `signals/` に追加し、GitHub の検索を HF の `githubRepo` 優先に変える | collect の Stage 2、人気度 | 小 | 46 の LLM 再順位付けの代わりの材料 | なし |
| **P1** | 毎週のシグナル記録（`data/state/signals/`）と、Δ★・被引用数の増え方の計算 | 人気度 | 小〜中 | — | collect の cron を戻すかどうか（40 §5-1） |
| **P2** | arXiv OAI-PMH による週次の母集団の取得（cs の 4 カテゴリ）＋bge-small（46 Stage 3） | collect の取りこぼし | 中 | 46 の関連度（LLM）→ 埋め込み | 46 の D3 |
| **P2** | arXiv のコメント欄から「Accepted to <会場> <年>」を抽出し、採択の兆しと補完に使う（「under review」「submitted」「workshop」を除く規則） | R3 (b) の早期警報、AAAI・ECCV の補完 | 小 | — | なし |
| **P2** | 承認 1 回の流れ：watch の candidate → PR（差分の表、件数ゲート、前回比）→ マージで promote。表示名と lede は yaml のテンプレートで作る | R3 の完了条件 | 中 | フォームの手入力を無くす | GitHub environment の reviewer 設定（ユーザー） |
| **P2** | はてなブックマーク件数と HN points の取得（週 1 回、上位 N 本だけ） | 人気度（日本語圏の補助） | 小 | — | なし |
| **P3** | Zenn・Qiita から arXiv を引用する日本語記事を紐づける（リンクだけ表示） | 日本語サイトとしての価値 | 小〜中 | — | Zenn は非公式 API（**D4**） |
| **P3** | AAAI を OJS の OAI-PMH から作り直す。DBLP の SPARQL で全回の件数を検算する | 網羅性の確認 | 小 | — | なし |
| **P3** | J-STAGE（JSAI 全国大会）の一覧化 | R5 の拡張候補 | 中 | — | J-STAGE の規約（表示義務）。**D5** |
| 見送り | Bluesky・Reddit・Altmetric・X・GitHub Trending・alphaXiv | — | — | — | 認証・有償・規約の重さに見合わない。Bluesky は認証するなら再検討 |

---

## 7. ユーザーが決めること

| # | 決定事項 | 選択肢（推奨を先頭） |
|---|---|---|
| D1 | virtual site の JSON（`/static/`、robots.txt で Disallow）の扱い | (a) 主催者（NeurIPS・ICML・ICLR の各 web チーム）に問い合わせ、許可が出た回だけ自動で取る。それまでは人が手で 1 回取得して dry-run に渡す／(b) 確定版の proceedings（PMLR・papers.nips.cc・ECVA）を待つ（数週〜数か月遅れる）／(c) 低頻度で自動取得する（非推奨） |
| D2 | OpenReview の認証付き取得を 1 回試すか | (a) ユーザーのアカウントで `/notes?limit=1` だけを試す（token は Secret に入れ、通らなければ廃止）／(b) 試さない |
| D3 | 人気度シグナルの毎週の記録を始めるか（collect の cron 再開と連動） | (a) シグナルの記録だけ、週 1 回の cron で始める（書き込み先は `data/state/`）／(b) collect の再開と同時に始める／(c) 始めない |
| D4 | 非公式 API（Zenn）を使うか | (a) Qiita（公式）だけ／(b) Zenn も低頻度で使う |
| D5 | 日本の学会（JSAI など）を一覧に加えるか | (a) R5 で判断する／(b) 今は加えない |

---

## 8. 実装の記録（R3-1、2026-10-11）

ユーザー決定 **D5=A**（学会の一覧は公式の proceedings から作り、新しい回は OpenReview の `/groups` で検知する。§4.1 の案 A のうち virtual site を除いたもの。§7 の D5〔日本の学会〕とは別の番号）を実装した。virtual site の JSON は robots.txt で禁止されているので使っていない。

### 8.1 やったこと

| 項目 | 内容 | 場所 |
|---|---|---|
| OpenReview の 403 | `/notes` の 403（`ChallengeRequiredError`）を **`source_blocked`** として扱う。`fetchNotes` は `outcome: "source_blocked"` を返し、それまでのページも捨てる。`collect_openreview` は exit 3 で何も書かない。watch 側は `CONF_SOURCE_BLOCKED`（kind=`error`）で、公開済みの件数と ID は保たれる（「0 件」や「縮んだ」と判定しない） | `conference/openreview/{fetchNotes,main}.ts`、`conference/watch/{models,openreview}.ts` |
| PMLR | 巻のページ（題名・著者・PMLR のページ・PDF・OpenReview の forum ID）と `bibliography.bib`（要旨）の **2 回の取得だけ**で作る。行の識別子は OpenReview の forum ID（`openreview:<id>`、これまでの ICML と同じ。系譜のコードは変えていない）。OpenReview のリンクが無い論文が 1 本でもあれば、ページの解析に失敗した論文があれば、書かない | `conference/pmlr/{volume,main,cli}.ts` |
| ACL Anthology | **2026 年の XML から `<url>` 要素が無くなっていた**ため、今のアダプタは ACL 2026 を 0 本と解析していた（書かずに止まる側の失敗）。`<collection id>-<volume id>.<paper id>`（例 `2026.acl-long.1`）から ID を組み立てるようにした。古い形式（`<url>` あり）はそのまま | `conference/acl/anthology.ts` |
| CVF | `--listing-only`：年の一覧 1 回だけで、題名・著者・リンクを取る。**要旨は取らない**（CVF はライセンスを与えていない。51 B5）。既定の動き（詳細ページと要旨）は、Python との一致テストのために残した | `conference/cvf/{listing,fetch,main}.ts` |
| NeurIPS proceedings | `papers.nips.cc` の年の一覧（1 回）を解析し、公開中の一覧と題名で突き合わせる報告だけを出す。要旨は取らない（著者は NeurIPS にだけ許諾している）。一覧には OpenReview の ID が無く、新しい識別子の種類を足すと系譜のコードに手が入るので、**一覧の生成には使わない** | `conference/neurips/{listing,cli}.ts` |
| 出所とライセンスの記録 | 各収集器が `papers_<date>.csv` の隣に `source_license.json` を書く（出典、ライセンス、帰属の文、要旨を載せたかとその根拠、PMLR は論文ごとの PMLR のページ）。画面への表示（51 A3・A6）はまだ | `conference/proceedings/sourceLicense.ts` |
| 新しい回の検知 | `/groups?id=venues` に会場の group が出たら、未公開の回を **pending-edition**（`phase: announced`、`status: pending_approval`、`auto_publish: false`）として記録する。新しい回だけ `/groups?id=<会場>` で開催日と場所を取る（1 回の実行で最大 11 回、1 秒間隔）。取得の失敗や 403 では記録を変えない（`last_check.status` に `source_blocked`／`error`）。公開済みになった回は記録から外す。**公開は一切しない** | `conference/watch/{groups,groupsCli}.ts`、`data/config/conference-editions-v1.json` |
| テスト | 2026-10-11 に取得した実物の抜粋（403 の本文、`/groups`、PMLR v306、2026.acl.xml、CVPR 2026 の一覧、NeurIPS 2024/2025 の一覧）で検証 | `apps/pipeline/test/conference/{proceedings,watch,openreview}/`、`fixtures/proceedings/README.md` |

### 8.2 ライセンスの確認結果

| 情報源 | 確認した文言 | 扱い |
|---|---|---|
| PMLR | 出版契約（`proceedings.mlr.press/pmlr-license-agreement.html`）：著者は論文を **CC BY 4.0** で一般に許諾する。帰属表示には proceedings の引用と PMLR のページへのリンクを含める | 要旨を載せる。`source_license.json` に CC BY 4.0、帰属の文、論文ごとの PMLR のページを記録 |
| ACL Anthology | 2016 年以降の資料は CC BY 4.0（フッター） | 要旨を載せる。帰属を記録（2016 年より前の collection はライセンスを `null` にし、要確認と書く） |
| CVF Open Access | 「Copyright and all rights therein are retained by authors」（ライセンスの付与なし） | `--listing-only` で題名・著者・リンクだけ |
| NeurIPS proceedings | 著者は NeurIPS に非独占の許諾をするだけ（`nips.cc/FAQ/Copyright`） | 題名・著者・リンクだけ、突き合わせ専用 |
| robots.txt | proceedings.mlr.press・papers.nips.cc・openaccess.thecvf.com・aclanthology.org はいずれも 404（制限なし） | 取得は 1 回の実行で 1〜2 回 |

### 8.3 実際に作った一覧

| 回 | 取得 | 結果 |
|---|---|---|
| **ACL 2026** | `acl/cli.ts --conference acl-2026 --venue acl --xml-id 2026.acl`（1 回、7.3 MB、約 2 秒）→ `buildSummaryCli` → `buildPagesCli`（全学会）→ `identityLiteCli`・`searchIndexCli`・`buildLineageQualityCli`（promote の再生成と同じ手順） | **2,296 本**（long＋short、全件に要旨）。`data/published/acl-2026/` と共有ファイルを更新。系譜は無し（`blocked`）。oral の情報は Anthology に無いので全件 Poster |
| **ICML 2026** | `PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx apps/pipeline/src/conference/pmlr/cli.ts --conference icml-2026 --venue ICML --volume 306`（2 回、合計 21 MB、約 3 秒）→ `buildSummaryCli --conference icml-2026` → 共有ファイルの再生成（ACL 2026 と同じ） | **6,552 本**（全件に OpenReview の ID と要旨）。最初は JS なしの一覧ページの上限 6,000 本で `buildPagesCli` が止まったが、R3-2（§8.5）でページを分けたあと `data/inputs/icml-2026/`・`data/published/icml-2026/` と共有ファイルを更新した（R3-2、2026-10-11）。全件 Poster |

ICML 2026 の掲載に必要だった判断（上限を上げるか、ページを分けるか）は、ユーザーが「ページを分ける」に決めた。実装は §8.5。

新しい回の検知は `pnpm exec tsx apps/pipeline/src/conference/watch/groupsCli.ts [--write]`（既定は dry-run）。2026-10-11 の実行（10 回の取得）で、未公開の 9 回を記録した：colm-2025、colm-2026、cvpr-2027、eccv-2026、emnlp-2026、iclr-2025、iclr-2027、icml-2026（PMLR）、neurips-2026（`data/state/conference-watch/pending-editions-v1.json`）。acl-2026 は上で生成したので対象外。

### 8.4 残り

- 画面とデータへのライセンス・帰属の表示（51 A3・A6）。`source_license.json` はまだどこからも読まれていない。
- PMLR と ACL の一覧には oral の区別が無い（全件 Poster）。必要なら arXiv のコメントで補う（ACL には `--oral-arxiv-query` がある）。
- 新しい回の検知を定期実行にするか（cron）と、記録した pending-edition から「承認 1 回で公開」までの流れ（§4.2 の残り、R3 の完了条件）。
- 既存の CVF 3 回分の要旨全文（51 §4）は手を付けていない。作り直すときは `--listing-only` を使う。
- NeurIPS 2025 の main track はまだ papers.nips.cc に無い（2026-10-11 時点で Creative AI の 64 本だけ）。

### 8.5 JS なしの一覧ページの分割（R3-2、2026-10-11）

ユーザー決定: JS なしの論文リンク一覧（`/<conf>/paper-links/`）を、上限を上げずに複数ページに分ける。

| 項目 | 内容 |
|---|---|
| URL | 1 ページ目は今までどおり `/<conf>/paper-links/`（既存の URL・リンク・`.html` からの 301 はそのまま）。2 ページ目以降は `/<conf>/paper-links/<n>/`。`/<conf>/paper-links/1/` は作らない |
| 1 ページの行数 | `NOJS_ROWS_PER_PAGE = 3,000`（タイトル順に並べて 3,000 行ずつ）。3,000 本以下の学会は 1 ページのままで、ページ送りも出ない（旧版との行の一致テストはそのまま通る） |
| 上限 | 大きさの上限 3 MiB（`NOJS_MAX_RENDERED_BYTES`）は **1 ページごと**。全体の上限は `NOJS_MAX_PAGES = 20` × 3,000 = **60,000 本**（`NOJS_MAX_PAPERS`、暴走した一覧を止める CAT-18 の役目は残す） |
| ページ送り | 各ページの上と下に、JS なしで動く番号のリンク（今のページは `aria-current="page"`）と「全 N 本中 a–b 本目」 |
| 生成側の検査 | `apps/pipeline/src/catalog/paperLinksGate.ts` は Web の並び順を再実装せず、**大きい順に 3,000 行を 1 ページに集めた最悪の場合**で 3 MiB を確かめる（これが通れば、どの並びでもどのページも超えない） |
| 検索エンジン | 2 ページ目以降も `noindex, follow`・canonical なし。sitemap には載らない（`robots` の meta で除外、今までと同じ） |
| スクリプト除去 | `scripts/strip-nojs.ts` が番号つきのページも `<script>` と `index.txt` を消す |
| 静的書き出しの注意 | `generateStaticParams` は `paper-links/layout.tsx` から `page.tsx` に移した。レイアウトに置くと `{conf}` が `[page]` に親の値として渡り、2 ページ目が無い学会が 1 つでもあると Next 15 の `output: export` が `[page]` 全体を「generateStaticParams が無い」として止める。`[page]/page.tsx` は `{conf, page}` の組を自分で全部返す |
| Cloudflare Pages の上限 | ファイル数は 1 学会あたり最大 20 ページ（今は ICML 2026 で 3、ICLR 2026・NeurIPS 2025・CVPR 2026・ICML 2025 で 2）。1 ファイル 25 MiB に対し 1 ページは最大 3 MiB |

変わったファイル: `apps/web/app/[conf]/paper-links/`（`logic.ts` に `paginatePaperLinkRows`・`buildPaperLinkPages`・`paperLinksPagePath`、表示を `view.tsx` に、読み込みを `read-papers.ts` に分け、`[page]/page.tsx` を追加）、`apps/web/scripts/strip-nojs.ts`、`apps/pipeline/src/catalog/paperLinksGate.ts`。テスト: `paper-links-logic`・`paper-links-pages`（ビルド結果で、全ページを合わせると `papers.json` の全件が 1 回ずつ同じ順に並ぶこと、ページ同士のリンク）・`strip-nojs`・`paper-links-build-safety`・`paperLinksGate`。

この上で ICML 2026（6,552 本、3 ページ）をリポジトリに入れた（§8.3）。表示用の文言は `apps/web/lib/catalog-copy.ts` に追加（出典は PMLR Volume 306、CC BY 4.0）。NeurIPS 2026（約 9,200 本）は 4 ページになる見込みで、そのまま載せられる。

## 付録 A：出典（2026-10-11 に確認）

- arXiv API Terms of Use：https://info.arxiv.org/help/api/tou.html （旧来の API は 3 秒に 1 回、同時接続 1）
- arXiv OAI-PMH：https://info.arxiv.org/help/oa/index.html （2025-03 に作り直し。メタデータは商用・非商用で再利用できる）
- arXiv RSS：https://info.arxiv.org/help/rss.html
- OpenReview API：https://docs.openreview.net/getting-started/using-the-api 、Terms：https://openreview.net/legal/terms
- OpenReview の `/notes` の challenge についての第三者の報告：https://odel.app/modules/pipeworx-io/openreview 、https://github.com/ktwu01/benchmark-radar/issues/81
- PMLR：https://proceedings.mlr.press/ 、https://github.com/mlresearch/v306
- CVF Open Access：https://openaccess.thecvf.com/menu
- ACL Anthology のデータ取得：https://aclanthology.org/faq/api/ 、https://github.com/acl-org/acl-anthology
- DBLP のクロールの FAQ（429・Retry-After・robots.txt・CC0）：https://dblp.org/faq/Am+I+allowed+to+crawl+the+dblp+website.html 、SPARQL：https://sparql.dblp.org/
- HF Hub の rate limits：https://huggingface.co/docs/hub/rate-limits
- Papers with Code の終了（2025-07）：https://reddit.com/r/MachineLearning/comments/1m8z9zk/ ほか
- GitHub の検索の上限：https://docs.github.com/en/rest/search/search
- HN Search API：https://hn.algolia.com/api （1 IP あたり 1 万回/時）
- Reddit Data API Wiki：https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki （OAuth 必須、100 QPM）
- Bluesky の検索が 403 になった件：https://raymondcamden.com/2026/02/05/building-a-bluesky-sentiment-dashboard-with-alpine-and-chrome-ai
- Altmetric のライセンス：https://docs.altmetric.com/details-page-api/licensing/
- Qiita API v2：https://qiita.com/api/v2/docs （鍵なし 60 回/時、トークンあり 1,000 回/時）
- Zenn の非公式 API の注記：https://github.com/zenn-dev/zenn-community/issues/209
- J-STAGE WebAPI：https://www.jstage.jst.go.jp/static/pages/JstageServices/TAB3/-char/ja （規約への同意、表示義務、商用は申請）
- CiNii API の利用登録：https://support.nii.ac.jp/ja/cinii/api/developer
- ccf-deadlines：https://github.com/ccfddl/ccf-deadlines

## 付録 B：参照したリポジトリのファイル

`docs/design/40-post-cutover-roadmap.md`（R3）、`44-data-sources.md`、`46-llm-free-collect.md`、`data/config/conference-sources-v1.yaml`、`.github/workflows/conference-on-demand.yml`、`apps/pipeline/src/conference/{watch,openreview,cvf,acl,arxiv}/*`、`apps/pipeline/src/collect/{sources,signals}/*`、`data/published/*/papers.json`（source・arxiv_id・github_stars の集計）。

> 生の取得結果は手元の一時領域に置いたため、リポジトリには入れていない（2026-10-11）。
