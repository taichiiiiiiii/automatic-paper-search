# 18. Lineage Trust と Focus View 契約

- **状態:** 設計確定・実装前
- **決定日:** 2026-08-30
- **対象:** conference / theme / deep lineage の妥当性表示、段階表示、URL 状態、評価・公開 gate
- **上位契約:** [`11-target-architecture.md`](11-target-architecture.md)、
  [`14-lineage-contract-v1.md`](14-lineage-contract-v1.md)、
  [`16-theme-lineage-migration.md`](16-theme-lineage-migration.md)

本書は、系譜の「関係が妥当か判断できない」と「node / edge が多すぎて読めない」を同時に解決する
producer、consumer、評価の実装契約である。canonical identity と quality/hash binding の原則は維持するが、
`lineage-artifact-v1` の edge shape は構造 provenance しか保証せず、引用という観測事実と研究系譜という解釈を
分離できない。semantic trust の出荷には、versioned migration による **`lineage-artifact-v2`** が必要である。

v2 は raw citation を `links`、genealogy / comparison の判断を decision ledger を兼ねる `claims` に分離する。
Focus View は、監査に合格した v2 artifact のうち `decision=accepted` かつ
`trust_tier=verified | corroborated` の genealogy claim から、表示用の決定的な部分グラフを作る。
既存 v1 / legacy artifact を推測変換して通常棚へ戻してはならず、v2 再生成・claim監査が完了するまでblockedを維持する。

---

## 1. 結論

1. raw citation の `links` と semantic assertion の `claims` を分離し、citation の存在を genealogy と呼ばない。
2. 関係の信頼性を **観測事実 / 機械による解釈 / 人手監査** の 3 層に分け、
   `verified | corroborated | tentative` の trust tier を付ける。
3. 証拠が足りない候補は `unknown` または `abstained`、反証・不採用は `rejected` として ledger に残し、
   6 種の relation へ強制分類しない。
4. 通常表示は focus を中心にした 2-hop の部分グラフとし、初期上限を
   **15 nodes / 18 claims / 各 node 2 branches** とする。
5. focus から祖先・後継へ一本ずつ伸びる **focus spine** を先に確保し、残りの枝を決定的順位で加える。
6. raw / LLM 自己申告 score は品質の代用品にしない。初期表示は tier を gate とし、`min_conf=0.70` は
   versioned calibration を持つ machine claim にだけ適用する。
7. 720px 以下は関係リストを既定とし、グラフと同じ部分グラフ・filter・件数を使う。
8. expand / collapse、表示件数、除外理由、claim inspector を提供し、全体を最初から描画しない。
9. quality row が `ready + passed`、artifact hash が一致し、v2 strict parse が成功する前に projection を行わない。
10. projection は node ID、claim、root、`seed_paper_id`、alias、evidence binding を変更・合成・推測しない。

---

## 2. 現況と問題

2026-08-30 の公開 snapshot では、非空 artifact は conference 最大 `158 nodes / 63 edges`、theme 最大
`44 nodes / 175 edges`、deep 最大 `17 nodes / 29 edges` である。現行 theme の既定 relation から
`contrasts` と `baseline_only` を除いても、Vision Transformer は 151 edges が残る。

現行 consumer の特性は次のとおりである。

| viewer | 現行の密度制御 | 残る問題 |
|---|---|---|
| conference | topics、tree の上下 3-hop、relation filter、mobile list | branch / node / edge 上限がなく、timeline は全 node |
| deep | relation filter、mobile list | BFS が無制限で、将来 artifact が大きくなると全 reachable node を描画 |
| theme | orphan 非表示、relation / 年 / 検索 filter、mini-map | 全体配置のまま。検索と年は非該当 node を薄くするだけで edge 数を減らさず、mobile list がない |

同 snapshot の非空 conference / theme / deep はすべて `audit_status=failed` であるため、現行 strict consumer は
通常表示しない。この fail-closed は維持する。以下の Focus View は未監査 artifact を見せる迂回路ではない。

### 2.1 Semantic trust の実測

2026-08-30 の `docs/lineage-quality-v1.json` では、edge を持つ collection は **19**、edge は合計 **475**、
`ready + passed` は **0** である。したがって現在の通常表示対象は 0 edge であり、475 edge を v2 へ
形だけ移すことはしない。

既存 54 pair の frozen gold set に deterministic heuristic を再実行した値は次のとおりである。

- accuracy `0.167`、macro-F1 `0.125`。
- `successor` は TP=6 / FP=25、precision `0.194`、recall `0.462`。
- title-version による `supersedes` は precision `1.0` だが recall `0.429`。単一 signal の高 precision を
  他 relation や collection 全体へ一般化しない。
- static snapshot は全54件で accuracy `0.241`、macro-F1 `0.165`、25件が未測定である。
  測定済み29件だけでも accuracy `0.448`、macro-F1 `0.237` に留まる。

この gold set は Vision Transformer / Flash Attention を中心とする単一ラベラーの小標本で、cross-paper
`ablation` は borderline な1件しかない。現行値は合格根拠ではなく、v2 fixture と calibration を作る際の
失敗 baseline として固定する。

### 2.2 Critical causes

| 原因 | 現行実装 | v2 の扱い |
|---|---|---|
| citation と genealogy の混同 | `build_conference_lineage._edge()` は OpenAlex citation を一律 `successor` 0.4 にする | citation は `links` にだけ入り、別の根拠なしに claim を作らない |
| 年代 heuristic の過剰分類 | `_derive_relation_heuristic()` は1〜5年差の citation を citation floor なしで `successor`、`_make_derived()` は一律0.7 | candidate signal に降格し、単独では `tentative`。較正不能なら通常表示しない |
| context regex の過剰主張 | `outperform` だけで `supersedes` 0.88、`baseline` だけで `baseline_only` 0.78、paragraph の priority-first match | parent の reference anchor、同一 task / metric / setting、source locator を検証する。語彙一致単独は assertion にしない |
| LLM confidence の未較正 | `RelationClassification.from_dict()` は欠損・不正値を0.7に補い、theme の0.4閾値も経験的 calibration ではない | `raw_score` と `calibrated_probability` を分離し、欠損を既定値で埋めない |
| allowlist の assertion 化 | foundational title regex に一致すると child の証拠なしで `extends` 0.65 | retrieval prior に限定し、relation claim は別途証拠を要求する |
| golden gate の空洞化 | audit fixture は node の `on_topic` だけで、edge relation をラベルしない | fixture v2 の `edge_labels` と二重 blind review を必須にする |

既存の structured provenance、cache v2、identity/hash binding は再現性の土台として再利用する。ただし
`source / kind / sha256` だけではユーザーが根拠箇所を確認できず、semantic correctness の証明にもならない。

---

## 3. 関係の信頼性モデル

### 3.1 `lineage-artifact-v2`

v2 は v1 の `root`、`nodes`、`clusters`、canonical focus identity を引き継ぐが、v1 `edges` を次へ分割する。

```text
lineage-artifact-v2
  nodes[]
  links[]       # sourceで観測した citation 等。semantic relation を主張しない
  evidence[]    # locator付きの immutable evidence record
  claims[]      # genealogy / comparison の claim decision ledger
  root / clusters / meta
```

`links[]` は少なくとも `id, src, dst, type=citation, evidence_ids` を持つ。引用方向は source 上の観測をそのまま表し、
`successor`、`extends` 等を含めない。`claims[]` は少なくとも次を持つ。

```json
{
  "id": "claim:<stable-hash>",
  "src": "<older-or-compared-node>",
  "dst": "<newer-or-comparing-node>",
  "claim_family": "genealogy",
  "relation": "successor",
  "decision": "accepted",
  "trust_tier": "corroborated",
  "raw_score": 0.82,
  "calibrated_probability": 0.76,
  "calibration_id": "relation-calibration-v1",
  "evidence_ids": ["evidence:<hash>"],
  "rationale": "...",
  "classification": {"method": "llm", "schema_version": "..."},
  "reason_codes": []
}
```

- `claim_family=genealogy` は `supersedes | successor | extends` とする。
- `claim_family=comparison` は `ablation | baseline_only | contrasts` とする。比較・分析を家系の spine に混ぜない。
- `decision` は `accepted | unknown | abstained | rejected` の閉じた enum とする。
- `unknown | abstained | rejected` も `claims` ledger に保持するが、relation arrow として描画しない。
  `unknown | abstained` の relation は `null` を許し、便宜的な relation を格納しない。
- `raw_score` は classifier の自己申告・規則 score、`calibrated_probability` は frozen calibration に基づく
  correctness probability である。後者は `calibration_id` と不可分とし、どちらも欠損時に0.7等で補完しない。
- accepted claim は link を参照できるが、citation link があることだけを accepted の根拠にしてはならない。

v2 は新しい JSON Schema、Python validator、JS strict reader、quality audit version を同時に導入する。
v1 reader が unknown key を無視して部分的に v2 を読む migration は禁止する。

### 3.2 Evidence record

`evidence[]` は hash だけでなく、根拠へ到達して同じ箇所を確認できる closed record とする。

- `source`、`kind`、`source_work_id`、citation の cited / citing endpoint。
- 原典またはprimary APIの `url`。検索結果 URL は使わない。
- `locator`: page、section、reference marker、sentence / paragraph ordinal 等の安定した位置情報。
- relation 判定に実際に使った短い `excerpt` と `excerpt_sha256`。excerpt は最大280文字とし、全文転載しない。
- 正規化入力全体の `input_sha256`、`retrieved_at`、immutable `snapshot_ref`。
- source response と endpoint を結ぶ canonical identity。title-only join は禁止する。

LLM prompt の場合も system/user の immutable snapshot と hash を evidence record から参照できるようにする。
UI に秘密、未公開全文、ライセンス上公開できない payload は出さず、公開可能な locator と短い excerpt だけを
redacted projection に含める。

### 3.3 Trust tier

| tier | 要件 | 通常表示 |
|---|---|---|
| `verified` | claim-specificな二重人手reviewでaccepted、またはexact version relation等を一次資料で決定的に確認 | 表示する |
| `corroborated` | 独立した2種類以上の evidence、method/relation slice の較正合格、DAG/temporal gate 合格 | 表示する |
| `tentative` | LLM単独、regex単独、year/citation単独、title/allowlist prior、または較正標本不足 | 初期非表示。探索 toggle のみ |

relation 固有の最低条件も固定する。

- `supersedes`: 同じ task / metric / setting での明確な置換根拠、または著者が明示するversion relationを要求する。
  `outperform` 一語だけでは不足する。
- `successor`: 同じ研究問題または mechanism と、先行研究からの漸進的 delta を両方要求する。年差だけでは不足する。
- `extends`: parent の具体的 mechanism を再利用し、domain / task / scale のどれを拡張したかを特定する。
  `methodology` intent だけでは不足する。
- `ablation | baseline_only | contrasts`: comparison claim として扱い、genealogy spine の祖先・後継数に数えない。
- foundational allowlist は候補検索 prior であり、`extends` の証拠ではない。

### 3.4 `unknown`、`abstained`、`rejected`

- `unknown`: 証拠は取得できたが、許可された relation を一意に決められない。
- `abstained`: 証拠欠損、provider障害、schema不一致、calibration不在等により分類を実行・採用しない。
- `rejected`: evidence が genealogy を支持しない、人手で不支持、または temporal / cycle constraint に反する。
- 3 decision を success cache hit や relation 正例にしない。failure を「関係なし」と数えず、未観測と観測ゼロも分ける。
- UI 集計は `候補 N 件中 accepted E / unknown U / abstained A / rejected R` を表示できるようにする。

### 3.5 個別 claim の人手監査

claim label は `(collection_id, src, dst, evidence_sha256)` を identity とし、relation と title は照合 key にしない。
review projection は artifact と同じ release 内で hash bind する。個別判定がない claim を「確認済み」と表示せず、
collection の標本監査合格と claim-specific review を区別する。

review projection が欠損、hash mismatch、endpoint不一致なら `verified` badge を表示せず、通常の artifact 認可も
緩めない。review後に evidence または endpoint が変われば label を自動失効させる。

### 3.6 Claim inspector と文言

グラフの claim 選択、関係リストの各行、キーボード操作のいずれからも同じ inspector を開ける。
inspector は少なくとも次を表示する。

- 始点・終点の title と graph-local ID。focus node では canonical `seed_paper_id` も表示する。
- claim family、relation の日本語名と定義、矢印方向。未reviewの断定語は
  `置換候補`、`後継候補`、`拡張候補` とする。
- `verified | corroborated | tentative` と、その tier になった理由。
- rationale、raw score、calibrated probability、calibration ID。
- evidence source / kind / source work、locator、短い excerpt、原典 link、SHA-256、producer version。
- classification method、provider / model、prompt / schema version。非 LLM は明記する。
- collection audit status、個別 review status / reason / reviewer / reviewed_at。
- 「観測事実」「機械による解釈」「人手監査」を別 section にする。

画面には常設で **「引用は研究継承を意味しません。この研究系譜は証拠と監査に基づく自動推定を含みます」** と示す。
未較正の `raw_score=0.8` を `確信度80%` と表示せず、`モデル自己評価 0.8（未較正）` とする。
`calibrated_probability` だけを `検証データに基づく推定正答率` と表示できる。collection audit と個別人手確認は別行にする。

SVG hover だけを根拠の入口にしない。claim はフォーカス可能な透明 hit target または隣接する
`詳細` button を持ち、Enter / Space で inspector を開き、Escape で閉じ、起点へ focus を戻す。

---

## 4. Quality gate と評価 gate

処理順序は固定する。

```text
quality manifest strict parse
  -> ready + passed eligibility
  -> artifact bytes / input_sha256 一致
  -> lineage-artifact-v2 strict parse
  -> identity / root / links / evidence / claims 検証済み artifact
  -> accepted + verified/corroborated genealogy claims
  -> Focus View projection
  -> graph / list / claim inspector
```

missing / failed / unknown / hash mismatch / parse failure は `data=null` の監査未合格表示とし、件数削減や
focus 指定を理由に一部だけ表示しない。

### 4.1 構造・identity gate

既存 gate の identity/hash 条件を維持し、`audit-v2` では少なくとも次を全件 gate とする。

- root / focus の一意解決、catalog 起点 focus の canonical `seed_paper_id`。
- duplicate node / link / claim、dangling endpoint、focus/root 以外の孤立 node が 0。
- link type、claim family / relation / decision / trust tier、closed structured provenance。
- `accepted | rejected` の relation assertion は非空 rationale、`unknown | abstained` は非空 reason code を持つ。
- alias conflict、canonical namespace の曖昧解決、focus mismatch が 0。
- artifact / fixture / manifest / evidence snapshot / review projection の hash binding。
- accepted genealogy に self-loop、双方向 contradiction、directed cycle が 0。
- accepted genealogy の方向は first-publication date で `src <= dst` とする。preprint / conference の同一 work は
  exact alias で統合し、年だけの一律 tolerance で別論文の逆転を許さない。日付が解決できない候補は
  `tentative` または `unknown` とする。
- cycle 候補を発見したら最低 tier、次に最低 calibrated probability、最後に claim ID 降順の claim を
  `rejected(reason_code=cycle_conflict)` へ決定的に落とし、accepted graph を DAG にする。
- raw citation link に対応する accepted claim がなくても正常とし、link 数を genealogy claim 数とみなさない。

### 4.2 Fixture v2 と人手 sampling

`lineage-audit-fixtures-v2` は node の topic label に加え、`edge_labels` を必須にする。各 label は少なくとも次を持つ。

```text
collection_id, src, dst, evidence_sha256,
reviews: [{reviewer_id, citation_valid, gold_family, gold_relation, evidence_support, notes}],
adjudication: {adjudicator_id, citation_valid, gold_family, gold_relation, evidence_support, reviewed_at}
```

- reviewer A/B は互いの回答と model prediction を見ずに blind label する。不一致は第三者が adjudicate する。
- Cohen's kappa または Krippendorff's alpha を relation / support について報告し、`>= 0.70` を要求する。
- calibration/train と frozen test は paper pair ではなく paper / topic 単位で分離し、同じ論文の近縁 pair が
  両側へ漏れないようにする。
- method × relation × source × trust tier を層化し、active な method × relation は frozen test 30件以上、
  初期全体300件以上を目標とする。30件未満の slice は calibration 合格にせず、その slice の通常表示 claim を
  claim-specific `verified` に限定する。
- 現行475 edge は初回移行時に全件 review する。以後は全 `supersedes`、全 focus 隣接、全 hub、全 temporal/cycle違反、
  全新規 method/model と、残りの method × relation × tier の決定的標本を含める。
- artifact bytes または参照 evidence hash が変われば fixture を失効させる。現行 v1 の `focus_labels/sample_labels`
  だけで semantic trust を passed にしない。

### 4.3 Calibration と frozen 評価

relation、unknown、abstained、rejectedを含むstratified frozen fixtureを用い、producer / model / prompt / schemaが変わるたびに
再評価する。ランダムな live API 応答だけを出荷判定に使わない。

`raw_score` は model / heuristic ごとに別々に calibration し、held-out set 上の isotonic regression または
Platt scaling のversionを `calibration_id` として固定する。標本不足、model mismatch、期限切れの calibration は
miss とし、raw scoreを probabilityへコピーしない。

初期出荷 gate は次とする。

- 通常表示される accepted genealogy 全体の selective precision は **95% Wilson lower bound >= 0.80**。
- 誤った断定の影響が大きい `supersedes` は **95% Wilson lower bound >= 0.90**。
- method × relation slice の Wilson lower bound が0.70未満なら、その slice は `tentative` に降格する。
- asserted relation の macro precisionは0.80以上。macro-F1、relation別precision/recall/F1、混同行列も報告するが、
  abstentionを減らすためにF1だけを最適化しない。
- evidence から rationale を支持できない率が 5% 以下。
- insufficient / conflicting evidence fixture に対する `unknown | abstained` recall が 90% 以上。
- candidate coverageを報告し、accepted coverage 20%以上を要求する。coverageを満たすために unknown / abstained を
  relationへ写像してはならない。
- `rejected`、`unknown`、`abstained`、`tentative` が初期 Focus spine に 0 件。
- accepted genealogy の self-loop、cycle、temporal reversal が 0。
- focus mismatch 0、既存の topic relevance sample off-topic 率 10% 以下。

calibration table は0.1幅で各 bin の件数・平均予測値・正解率を記録する。十分な frozen test 上で
**10-bin ECE <= 0.10、Brier score <= 0.15** を要求する。件数不足時は合格扱いにせず
`insufficient_sample` とし、その slice は `tentative` または claim-specific `verified` に限定する。

評価 report は assertion 数だけでなく `unknown_rate`、`abstained_rate`、`rejected_rate`、coverage、selective risk curve、
relation 別混同行列、evidence coverage、source / method / provider / model / prompt / calibration version別の成績を残す。

---

## 5. Focus View の決定的 projection

### 5.1 入力と不変条件

projection の入力は strict parse 済み v2 artifact、解決済み focus ID、表示 filter だけである。

- canonical focus は `LineageCore.resolveFocus()` で解決する。未知 ID は root や先頭 node へ fallback しない。
- focus 指定がない場合だけ、監査済み `artifact.root` を使う。
- 初期 eligibility は `decision=accepted`、`trust_tier in {verified, corroborated}`、
  `claim_family=genealogy` の claim だけである。
- node / claim / evidence は元 object を参照し、ID、alias、relation、score、rationale、provenanceを
  書き換えない。
- title、year、類似度で node を merge しない。projection 固有 ID を canonical ID として発行しない。
- selected claim の endpoint は必ず selected node に含め、dangling relation を作らない。

### 5.2 既定値

| 設定 | 既定 |
|---|---:|
| hop depth | 上下 2-hop |
| node 上限 | 15 |
| claim 上限 | 18 |
| spine | 各 hop で祖先 1、後継 1 |
| branch 上限 | 各表示 node 合計 2 |
| decision | `accepted` |
| trust tier | `verified, corroborated` |
| claim family | `genealogy` |
| minimum calibrated probability | 0.70（`corroborated` のみ。`verified` は除外しない） |
| genealogy relation | `supersedes, successor, extends` |
| comparison relation | 初期なし。明示 toggle で `ablation, baseline_only, contrasts` |
| mobile view | 720px 以下は `list` |
| list page size | 20 claims |

comparison claim は明示的に有効化できるが、focus spine、祖先・後継件数、genealogy branch quotaには含めない。
`tentative` は別の「要確認を表示」toggleでのみ表示し、comparison toggleと混同しない。保存済み設定より URL、
responsive default より保存済み設定を優先し、優先順位は既存どおり
`URL > 保存済み設定 > responsive default` とする。

### 5.3 選択順

1. decision、trust tier、claim family、relation、`min_conf`、evidence filter を満たす eligible claim を作る。
   `min_conf` は `calibrated_probability` にだけ適用し、`verified` を欠損 probability で除外しない。
2. focus を必須 node とする。
3. focus から親方向・子方向へ、genealogy claimだけを各 hop で1本ずつ辿り focus spine を作る。
4. spine node を BFS 順に処理し、未選択の隣接 genealogy claim を各 node 合計2 branchesまで加える。
5. 2-hop、15 nodes、18 claims のいずれかへ達したら初期選択を止める。
6. selected nodes 間の genealogy cross claim は traversal claim の後、同じ順で上限まで追加する。
7. comparison toggle が有効な場合だけ、selected nodes 間の comparison claim を最大6件、かつ全体18件の
   claim上限まで追加する。genealogy spineとbranch quotaは消費しない。

claim の比較順は次の tuple とし、入力配列順に依存させない。

```text
trust tier rank (verified, corroborated, tentative),
calibrated_probability desc (null last),
relation rank (supersedes, successor, extends),
opposite endpoint total degree desc,
src graph-local ID asc,
dst graph-local ID asc,
claim ID asc
```

degree は accepted genealogy claim から算出するが、順位付けにしか使わない。高 degree を関係の正しさとは表示しない。
DAG gate 後も defensive に visited node / claim set で停止する。spine だけで上限を超える場合は近い hop を優先する。

### 5.4 Expand / collapse

- node に隠れた隣接 genealogy claim がある場合、`親をさらに N 件`、`後継をさらに N 件` を表示する。
- 1 回の expand は同じ決定順で最大 2 branches を追加する。
- collapse はその操作で追加した部分木だけを除き、focus spine は除かない。
- 明示 expand 後も graph は一度に 50 nodes / 80 claims を超えて描画しない。超える要求は関係リストへ切り替え、
  20件単位で継続表示する。
- focus を変更したら既定 projection へ戻す。戻る操作では URL に記録された直前の focus / expand 状態を復元する。
- expand 対象は graph-local ID の exact match のみ。未知 ID は無視して status message を出す。

### 5.5 件数と除外理由

toolbar 直下に、例えば
`15 / 44 論文、18 / 63 信頼済み系譜を表示 · 2-hop · verified/corroborated · 較正値70%以上`
を常時表示し、更新を `aria-live="polite"` で通知する。

claim の非表示理由は重複計上を避け、次の優先順で集計する。

1. decision (`unknown | abstained | rejected`)
2. trust tier (`tentative`)
3. claim family (`comparison`)
4. relation filter
5. calibrated probability filter
6. evidence filter
7. hop 外
8. branch 上限
9. node / claim 上限
10. collapse

raw `links`、全 claim decisions、accepted claims、eligible、shown を別々に数える。`全 E edges` のように
citationとgenealogyを一つの分母へ混ぜない。quality manifest の宣言件数とartifact実数が違う場合は表示を続けず
gate failure とする。v2 quality row は少なくとも `link_count`、`claim_decision_count`、
`accepted_genealogy_count`、`accepted_comparison_count` を別 field で宣言する。

---

## 6. Viewer 別の適用

### Conference

- `?focus=<canonical paper_id>` を維持し、選択済み論文では Focus View を既定にする。
- focus なしの topics は初期 12 focus cards と `12 / 全 N 本` を表示する。
- timeline は初期 30 nodes とし、全件表示は明示操作にする。claim は同じ eligibility / cap を使う。
- root button は監査済み root を focus にし、未知 focus を root に置き換える操作には使わない。

### Deep

- manifest の `paper` / legacy `arxiv` 解決と hash binding を維持する。
- unbounded BFS を既定にせず 2-hop から開始する。3-hop、個別 expand、関係リスト全件へ進める。
- card click による graph-local focus 変更は identity を変更せず、表示中心だけを変える。

### Theme

- `?node=` の canonical seed、exact alias、graph-local ID 解決順と 40-hex 予約を維持する。
- root への自動 scroll だけでなく、root 中心の Focus View を既定にする。
- 検索・年代 filter は dimming だけでなく projection 入力の node / claim を実際に除外する。
- conference / deep と同じ `view=list|graph` を追加し、mobile は list を既定にする。
- mini-map は graph の補助ナビに限定し、`aria-hidden` の canvas を唯一の情報源にしない。

---

## 7. URL と保存状態

既存 parameter は削除・改名しない。次を additive に扱う。

| parameter | 値 | 動作 |
|---|---|---|
| `view` | `list | graph` | URL が responsive / 保存値に優先 |
| `hops` | `1 | 2 | 3` | 既定 2。不正値は 2 |
| `limit` | `5..50` | graph node 上限。既定 15 |
| `min_conf` | `0.5 | 0.7 | 0.9` | 既定0.7。calibrated probabilityにだけ適用 |
| `trust` | `verified,corroborated,tentative` の CSV | 既定は前2つ。`tentative` は明示時のみ |
| `families` | `genealogy,comparison` の CSV | 既定 `genealogy` |
| `relations` / `rels` | relation enum の CSV | viewer の既存 keyを維持。familyと整合する値だけ採用 |
| `evidence` | 許可済み source/kind の CSV | 未知値は採用せず status を出す |
| `expanded` | graph-local node ID の CSV | sort・dedupし、exact match のみ |

conference の `focus`、theme の `node`、deep の `paper` / `arxiv` は従来の identity parameter を維持する。
focus / paper 選択は `pushState`、表示・filter・expand は `replaceState` とする。URL に明示された空 relation 集合を
「既定 relation」と解釈せず、0件表示として復元できる表現を用意する。

`expanded` は表示状態であり canonical identity ではない。URL へ出す前に artifact 内 ID との exact match、件数上限、
長さ上限を検証する。localStorage は既定値を補うだけで、URL の canonical focus を上書きしない。

---

## 8. Mobile とアクセシビリティ

- 720px 以下で URL / 保存指定がなければ `view=list`。
- list row は始点、終点、claim family、relation、trust tier、較正状態、rationale、evidence、人手監査状態を持つ。
- filter、view、expand、inspector の hit target は 44px 以上。
- graph と list は同じ projected claim set を使い、切替で件数や filter が変わらない。
- focus / expand / filter 後は件数を live region で通知する。再描画だけで keyboard focus を `body` へ落とさない。
- inspector は dialog semantics、label、focus trap、Escape、focus restoration を持つ。
- node card は Enter / Space で focus 変更、expand button は別操作とし、カード全体 click と混同しない。
- reduced motion では自動 scroll と展開 animation を抑止する。
- 320 / 375 / 720 / 768 / 1024 / 1440px で body の意図しない横 overflow を 0 にする。

---

## 9. 実装対象と task 分割

順序は `v2 contract -> producer/decision ledger -> fixture/calibration gate -> consumer -> Focus View` とする。
Focus View だけを先行公開して v1 edge を「信頼済み」に見せない。

### T18-1: Artifact v2 contract

- `lineage-artifact-v2`、`lineage-audit-fixtures-v2`、`lineage-quality-v2` の JSON Schema と
  Python / JS validator を同時に追加する。
- `links / evidence / claims` の closed shape、decision / trust tier / claim family、hash binding、
  accepted genealogy の DAG / temporal constraint を実装する。
- v1 reader と v2 reader をversionで分離し、legacy/v1の推測変換を禁止する。

### T18-2: Producer と decision ledger

- conference / theme / deep producer を raw citation acquisition と semantic claim classification の2段に分ける。
- citation heuristic、year_cite、context regex、foundational allowlistをcandidate signalへ降格する。
- `unknown | abstained | rejected` を artifact ledgerとrun metricsへ残し、success cacheへ入れない。
- evidence locator / excerpt / source work / snapshotを収集し、provider failure時にfail-open relationを作らない。

### T18-3: Fixture、calibration、quality gate

- fixture v2 `edge_labels`、二重 blind review、adjudication、agreement metrics を実装する。
- method × relation sliceのcalibrator、Wilson interval、ECE、Brier、coverage / selective risk reportを追加する。
- §4.3を満たさないsliceを `tentative` に降格し、collectionを`ready + passed`にしない。

### T18-4: Pure projection core

- `docs/assets/lineage-core.js`
- `selectFocusProjection()`、filter 正規化、決定的 claim comparator、件数・除外理由集計を副作用なしで実装する。
- v2 strict parse後の accepted verified/corroborated genealogyだけを初期入力とする。

### T18-5: Conference / deep consumer

- `docs/assets/lineage.js`
- `docs/assets/deep.js`
- `docs/iclr-2026/lineage.html`
- `docs/eccv-2024/lineage.html`
- `docs/iclr-2026/deep.html`
- hop / trust / calibrated probability / count / expand / inspector を追加し、conference timeline と deep unbounded default を置換する。

### T18-6: Theme parity

- `docs/assets/theme.js`
- `docs/themes/index.html`
- theme の filter を実 subset に変更し、list / mobile default / focus projection / inspector を追加する。

### T18-7: Shared presentation and review projection

- `docs/assets/style.css`
- review fixture のredacted public projection、hash binding、unknown / abstained / rejected集計を
  producer / schema / quality read modelに追加する。
- citation disclaimer、未較正文言、trust badge、comparison / tentative toggleを実装する。

### T18-8: Tests and large-graph fixture

- `paperpilot/tests/test_lineage_v2_contract.py`
- `paperpilot/tests/test_lineage_claim_constraints.py`
- `paperpilot/tests/test_lineage_fixture_v2.py`
- `paperpilot/tests/test_lineage_calibration_gate.py`
- `paperpilot/tests/viewer/test_lineage_core.mjs`
- `paperpilot/tests/viewer/test_lineage_viewer_contract.mjs`
- `paperpilot/tests/viewer/test_theme_lineage_contract.mjs`
- `paperpilot/tests/viewer/test_theme_xaxis_layout.mjs`
- `paperpilot/tests/test_lineage_viewer_contract.py`
- 200 nodes / 1,000 claims + raw links の決定的 fixtureを追加する。
- contract、semantic gate、Focus Viewの受入条件を下記§10の順でtest-firstに固定する。

### T18-9: Staged regeneration と promotion

- v2 artifactは公開pathを上書きせずstagingへ生成し、v1/legacy quality rowはfailed/blockedのまま維持する。
- 現行475 edgeに対応するcandidateをfixture v2で全件reviewし、evidenceを再取得できないものは`abstained`、
  支持されないものは`rejected`へ落とす。titleや旧rationaleからevidenceを逆算しない。
- contract、fixture、calibration、DAG/temporal、hash bindingの全gateを通ったcollectionだけ、v2 artifactと
  quality rowを同一releaseでatomicにpromoteする。
- Focus View consumerを先にv2対応しても、passed v2 rowがない間は監査未合格表示を維持する。

---

## 10. 受入条件

- quality missing / failed / unknown、hash mismatch、v2 strict parse failureではprojection / artifact renderを行わない。
- v1 / legacy artifactはblockedのままで、v2 readerへ推測変換されない。
- citation linkだけのfixtureからaccepted genealogy claimが生成・描画されない。
- `outperform`、`baseline`、1〜5年差、foundational allowlistの各単独signalは`tentative`以下になり、初期表示されない。
- confidence欠損/不正値は0.7へ補完されず、`calibrated_probability`なしのmachine claimを`corroborated`にできない。
- evidenceのsource work / locator / excerpt hash / endpoint bindingの欠損または不一致を拒否する。
- unknown / abstained / rejectedをrelation arrow、success cache hit、precisionの正例にしない。
- accepted genealogyのself-loop、双方向contradiction、cycle、temporal reversalを0にする。
- fixture v2は二重blind labelとadjudicationを要求し、node on_topicだけではsemantic gateをpassしない。
- Wilson lower bound、ECE、Brier、sample不足の各failureでcollectionが`ready + passed`にならない。
- 同一artifact・focus・設定から、入力配列順にかかわらず同じnode / claim順を返す。
- 初期表示はaccepted verified/corroborated genealogyだけで、必ず`nodes <= 15`、`claims <= 18`、
  focusから`hop <= 2`、各nodeの追加branch`<= 2`。
- comparison / tentativeは別toggleで、どちらもfocus spineとgenealogy branch quotaに入らない。
- focusとfocus spineをcapより先に保持し、selected claimのdangling endpointは0。
- relation / trust / calibrated probability / evidence filterはgraphとlistで完全に一致する。
- inspectorは観測事実、解釈、人手監査を分離し、未確認claimを確認済みと表示しない。
- 未較正raw scoreを`確信度`や正答率として表示せず、citation disclaimerをgraph/listの両方に常設する。
- unknown canonical focus は root、先頭 node、title 類似 node へ fallback しない。
- projection前後で`seed_paper_id`、alias、graph-local ID、root、claim/evidence provenanceがbyte-equivalent。
- URL round-tripでfocus、view、hop、limit、calibrated probability、trust、family、relation、evidence、expand状態を復元する。
- URL filter は `replaceState`、focus 選択は `pushState`。戻る操作で直前状態を復元する。
- mobile の URL 指定なしは list、URL `view=graph` は mobile でも優先する。
- list 20件 paging、graph 明示展開 50 nodes / 80 claims safety cap、超過時のlist誘導が動作する。
- 320〜1440px の指定幅で body overflow なし、44px target、keyboard inspector、focus restoration、
  reduced motion がテストされる。
- frozen評価が§4.3のgateを満たさないcollectionは`ready + passed`にならず、通常棚へ出ない。

Focus Viewは「正しくない可能性のあるclaimを少なく見せる」仕組みではない。妥当性は生成・評価・人手監査でgateし、
Focus View はその後の監査済み集合を理解可能な量へ段階表示する仕組みである。
