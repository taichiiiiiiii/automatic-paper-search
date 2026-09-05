# 19. Top Conference Release Watch v1 実装契約

- **更新日:** 2026-08-30
- **状態:** 設計確定・実装前
- **対象:** 許可済みトップ学会の新年度検出、公式 proceedings の安定確認、全件収集、検証、昇格、公開
- **初期 adapter:** OpenReview（ICLR / NeurIPS / ICML）
- **上位設計:** [`11-target-architecture.md`](11-target-architecture.md)
- **関連契約:** [`14-lineage-contract-v1.md`](14-lineage-contract-v1.md)、
  [`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md)

この文書は、トップ学会の採択論文が公式 source に公開された後、PaperPilot の catalog を安全に自動更新する
detector、collector、validator、state、workflow の共有契約である。「トップ学会」を外部検索から自動選定する機能ではない。
対象 venue は repository 内の curated allowlist に人が明示登録し、その venue の年度 edition だけを自動探索する。

現行の `collect-weekly.yml` と `collect-daily-watch.yml` は `workflow_dispatch` 専用である。前者は一般トピックの
Stage 0–4 collector と既存 output の再投影、後者は著者 follow-watch であり、新年度 conference、公式 proceedings、
OpenReview `venueid` を発見しない。`conference-on-demand.yml` も operator が slug、venue、arXiv query 等を入力する
手動処理である。したがって、2026-08-30 時点では conference catalog は自動更新されない。

---

## 1. 保証範囲と原則

v1 は次を保証する。

1. curated allowlist に登録した venue 以外を収集・公開しない。
2. 許可された年度 template から bounded に生成した edition だけを probe する。
3. 公式 source が未公開、空、部分公開、変動中の場合は catalog を公開しない。
4. 同一 source fingerprint を時間の離れた 2 probe で観測し、件数・identity・重複・縮小 gate を通した場合だけ
   `ready` とする。
5. 収集 job は write credential を持たない candidate producer とし、fresh `develop` tip 上の validator / promoter が
  競合を拒否してから commit する。
6. Pages は promoter が返した exact SHA を既存 reusable release に一度だけ渡す。
7. 同じ upstream fingerprint を再観測した場合は no-op とし、同じ catalog を日付違いで再生成しない。
8. catalog、conference lineage、paper slide deck を別の成果物・品質状態として扱う。

v1 は未知 venue の推薦、ランキングによる「トップ」判定、一般 Web scraping、arXiv 自己申告を公式採択集合として
使うこと、ECCV / ECVA、workshop / Findings / demo track、lineage の自動認可、全論文の slide 一括生成を行わない。

---

## 2. End-to-end 状態遷移

```text
scheduled probe
  ├─ 404 / accepted=0 ───────────────> unavailable（no-op）
  ├─ timeout / 429 / 5xx / parse error -> probe_failed（stateを進めない）
  ├─ count gate未満 ─────────────────> partial（観測のみ）
  ├─ fingerprintが前回と異なる ─────> stabilizing（連続回数を1へ戻す）
  └─ 同一fingerprintを2回、間隔条件内で観測
       └─ preflight gate合格 ─────────> ready
            -> credentialなしでexact snapshotを再収集
            -> candidate検証
            -> fresh-tip promotion + shared projections再生成
            -> required tests / data audit
            -> exact promoted SHA release
            -> published
```

`ready` 後の収集時 fingerprint が probe 時と一致しなければ、古い snapshot を公開せず `stabilizing` に戻す。
公開済み edition も監視を継続し、公式集合へ追加・metadata 修正があれば同じ 2 probe 安定条件で更新する。
identity の削除または件数縮小は自動更新しない。

---

## 3. Curated registry

実装時に `paperpilot/data/conference-sources-v1.yaml` を正本として追加する。`docs/conferences.json` は公開 projection で
あり、allowlist や収集設定の正本にしてはならない。registry は review 必須の通常コード変更として扱い、scheduled
workflow や upstream response が venue entry を追加・編集してはならない。

概念 schema は次とする。実装時は runtime validator と closed JSON Schema を併設する。

```yaml
schema_version: conference-sources-v1
defaults:
  probe_interval_hours: 6
  stable_probe_count: 2
  stable_min_separation_hours: 6
  stable_max_separation_hours: 48
  max_future_years: 1
venues:
  - venue_key: iclr
    enabled: true
    curated_class: top
    display_template: "ICLR {year}"
    slug_template: "iclr-{year}"
    adapter: openreview-v2
    source_id_template: "ICLR.cc/{year}/Conference"
    first_year: 2026
    active_months_utc: [1, 2, 3, 4, 5]
    count_gate:
      minimum_absolute: 1000
      previous_edition_min_ratio: 0.70
      previous_edition_max_ratio: 1.50
    tracks:
      accepted_only: true
      highlighted_labels: [oral, spotlight, spotlightposter]
```

### 3.1 Registry validation

- `schema_version` は完全一致、top-level と各 entry は closed object とする。
- `venue_key` は lowercase `[a-z0-9-]` の一意な安定 ID、`slug_template` の展開結果は
  `^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])$` とし、`daily` を拒否する。
- `curated_class=top` は表示ラベルではなく allowlist admission を表す。外部 citation 数や検索結果で変更しない。
- v1 の `adapter` は `openreview-v2` だけを許可する。将来の CVF / ACL adapter は同じ interface と専用 test を
  追加した後に列挙へ加える。
- template engine は `{year}` 一個の置換だけを実装する。式、format specifier、attribute access、環境変数、shell 展開、
  任意文字列補間を禁止する。
- year は UTC の現在年と翌年だけを候補にでき、`first_year <= year <= current_year + max_future_years` を満たす。
  registry で明示的に小さくした範囲を workflow 入力で広げてはならない。
- `active_months_utc` 外は既存 published edition の再確認を除き probe しない。日程変更時は registry PR で直す。
- count ratio は同じ venue の直近 published edition を基準にする。基準がない初年度は `minimum_absolute` と
  人手 dry-run 承認を必須にする。
- registry entry の追加、source template 変更、count gate 緩和、track policy 変更は自動昇格せず、review record を残す。

---

## 4. Adapter contract — `openreview-v2`

adapter は任意 URL を受け取らず、検証済み `source_id` から固定 API endpoint と query parameter を構成する。
OpenReview v2 の `content.venueid=<source_id>` で accepted notes を page 全件取得し、各 note の venueid が完全一致する
ことを再確認する。

```python
class ConferenceSourceAdapter(Protocol):
    name: str
    version: str
    def probe(self, edition: Edition, limits: FetchLimits) -> ProbeObservation: ...
    def collect(self, edition: Edition, limits: FetchLimits) -> SourceSnapshot: ...
```

`probe()` も pagination を最後まで行う。先頭 page の件数、API の推定総数、HTTP 200 だけで ready と判定しない。
`collect()` は probe と同じ normalization と fingerprint 関数を使い、normalized rows と fingerprint を返す。

OpenReview v2 の必須条件:

- note ID、title、source venueid が非空で、note ID は edition 内で一意
- `content.venueid` が target と異なる withdrawn / rejected record は除外
- accepted decision label は registry の track policy で解釈し、未知 label の件数を report する
- native identity は `source=openreview`、`source_id=<case-sensitive note id>` とし、title join を使わない
- page 上限、response byte 上限、timeout 到達前に pagination が完了しなければ snapshot 全体を失敗にする
- 部分 page を成功 snapshot として返さない。既存 collector の fail-safe partial result は watch の publish path では
  strict wrapper により拒否する

arXiv collector は公式 adapter が利用不能な場合の自動 fallback にしない。公式 source 障害時は既存 catalog を保持し、
failure を通知する。

---

## 5. Probe observation と source fingerprint

HTTP body や raw note を Git、log、Step Summary、公開 JSON に保存しない。normalization 後の最小 observation と hash だけを
state に保存する。

```json
{
  "schema_version": "conference-probe-observation-v1",
  "edition_id": "iclr-2027",
  "adapter": "openreview-v2",
  "adapter_version": "1",
  "source_id": "ICLR.cc/2027/Conference",
  "observed_at": "2027-01-20T06:00:00Z",
  "http_class": "ok",
  "accepted_count": 5321,
  "unknown_label_count": 0,
  "source_fingerprint": "64 lowercase hex",
  "status": "stabilizing"
}
```

fingerprint input は、adapter version、edition ID、source ID と、全 accepted row の次の normalized fields を
native source ID 昇順に並べた canonical JSON とする。

```text
[source_id, title, authors[], abstract, landing_url, pdf_url, decision_label]
```

UTF-8、key sort、compact separators、末尾 LF 一つ、`allow_nan=false` とし SHA-256 を取る。日時、HTTP header、取得順、
pagination offset、retry 回数は含めない。同じ upstream 内容は別 run・別 page 分割でも同じ fingerprint になる。
同じ件数でも title、author、abstract、decision が変われば別 fingerprint として安定回数をリセットする。

raw response の短期 Actions artifact 保存を将来行う場合は private retention、実 byte hash、size、expiry、secret scan を
run manifest に記録し、Git / Pages には置かない。v1 の readiness は raw artifact の存在を前提にしない。

---

## 6. Durable readiness state

実装時に `paperpilot/data/conference-release-state-v1.json` を追加する。これは生成状態であり registry ではない。
state update は compare-and-swap 可能な単一 writer job だけが行い、probe job は write credential を持たない。

edition row は少なくとも次を持つ。

```json
{
  "edition_id": "iclr-2027",
  "venue_key": "iclr",
  "year": 2027,
  "phase": "unavailable | partial | stabilizing | ready | generating | published | anomaly",
  "last_observation": {},
  "stable_fingerprint": null,
  "stable_observations": 1,
  "first_seen_at": "2027-01-20T06:00:00Z",
  "last_seen_at": "2027-01-20T06:00:00Z",
  "published_fingerprint": null,
  "published_count": null,
  "published_source_sha": null,
  "last_failure_code": null
}
```

### 6.1 Two-probe readiness

- 同じ fingerprint の成功 probe だけを連続観測として数える。
- 2件は異なる scheduled run ID で、時刻差が `stable_min_separation_hours` 以上かつ
  `stable_max_separation_hours` 以下でなければならない。同一 run の retry は一件と数える。
- fingerprint が変わったら `stable_observations=1` とし、新 observation を起点にする。
- max separation を超えた古い observation は連続性を失い、一件目として再開する。
- 404、空集合、partial、rate limit、timeout、5xx、parse failure は stable count を増やさない。
- transient failure は最後の成功 observation を削除しないが、ready への遷移にも使わない。
- `ready` は予約ではない。generator 開始時に state と current source を再検証する。

state-only commit は Pages release を起動しない。state に URL、raw response、secret、header、例外本文を含めない。
同じ observation を CAS retry で再適用しても byte-identical no-op になる reducer とする。

---

## 7. Readiness / publication gates

### 7.1 Availability と count

- 404 または公式 collection 不在: `unavailable`
- 200 かつ accepted 0: `unavailable`。空 catalog を生成しない
- `0 < count < effective_minimum`: `partial`
- `effective_minimum = max(minimum_absolute, floor(previous_count * previous_edition_min_ratio))`
- `effective_maximum = ceil(previous_count * previous_edition_max_ratio)`。直近 edition がある場合に超過したら、
  reject ではなく `anomaly` として人手確認する
- published edition の更新では `new_count >= published_count` かつ published native ID が全て残ることを要求する
- count 縮小、既存 ID 消失、source ID 再利用は `anomaly`。自動で削除・上書きしない

count gate は完全性の証明ではなく、明白な partial / wrong source を止める安全装置である。2 probe 安定、track policy、
identity gate と組み合わせてのみ ready にできる。

### 7.2 Identity と duplicate

- normalized row の 100% が adapter の native `source` / `source_id` と deterministic `paper_id` を持つ
- source ID、paper ID、canonical landing URL の edition 内 duplicate は 0
- strong alias が異なる paper ID を指す conflict は 0
- title-only dedup / merge / fallback は禁止
- 欠損 title、欠損 authors、target source mismatch、invalid URL は 0
- duplicate title は report するが、それだけで同一論文として統合しない

### 7.3 Projection と data quality

- CSV、summary、`docs/<slug>/papers.json` の件数が source snapshot と一致
- `docs/conferences.json`、legacy/v2 search index、identity aliases、detail shards、lineage quality を fresh tip で全再投影
- JSON/schema、決定論的順序、snapshot date、source fingerprint binding、secret scan が成功
- full ruff / pytest、公開 bundle validation、conference/theme lineage audit が成功
- 新規 catalog page の slug、display、navigation、404/sitemap/search 到達性を contract test で検証
- gate failure では candidate、state の published fields、既存 catalog を変更しない

---

## 8. Workflow contract

実装対象 workflow 名は `.github/workflows/conference-release-watch.yml` とする。

### 8.1 Trigger と concurrency

- `schedule` は UTC 6時間ごとを既定とし、`workflow_dispatch` の dry-run を併設する
- scheduled run は registry の active window にある edition だけを probe する
- workflow input から venue、year、source ID、URL、count gate を自由入力させない。手動実行も registry entry を選ぶだけ
- concurrency group は state / promotion 全体で一つにし、`cancel-in-progress: false` とする
- 同時 run は state writer / catalog promoter の CAS で直列化し、古い base の candidate は再生成させる

### 8.2 Job separation

```text
probe        permissions: contents:read
  -> state-candidate（secretなし、credentialなし）
state-promote permissions: contents:write
  -> stateだけCAS commit、Pages releaseなし
generate     permissions: contents:read
  -> ready editionを再収集、candidate artifact upload
promote      permissions: contents:write
  -> fresh develop tip、allowed path、shared projection、full validation、commit
release      permissions: contents:read, pages:write, id-token:write
  -> existing pages-release.yml(source_sha=exact promoted SHA)
```

root `permissions` は `{}`。checkout action と setup action は immutable commit SHA pin を使い、generation checkout は
`persist-credentials: false` とする。artifact 名は bounded run ID から作り、candidate は repository-relative allowlist、
symlink 禁止、retention 14日以内とする。

promotion は既存 `package-generated-candidate.sh`、`promote-generated.sh conference`、`pages-release.yml` の契約を再利用する。
generation base 以降に同一 allowed path が変わった candidate は上書きせず再生成する。release は `changed=true` の場合だけ、
promoter output の exact SHA を一度渡す。branch tip や mutable ref を release source にしない。

### 8.3 No-op と idempotency

次の場合は成功 no-op とし、catalog commit / Pages release / failure 通知を行わない。

- active edition がない
- 404、accepted 0、count gate 未満
- stable 2 probe 未達
- `source_fingerprint == published_fingerprint`
- generated bytes と fresh-tip projection に差分がない

同じ ready state の retry は同じ edition / fingerprint generation key を使う。一度 published になった fingerprint を再収集せず、
別日付の `papers_YYYY-MM-DD.csv` を増やさない。公開 snapshot date は readiness を満たした source observation に binding し、
wall-clock retry 時刻で変えない。

---

## 9. Dry-run first と rollout

実装直後は workflow-level `apply_enabled: false` を固定し、schedule / manual とも次だけを行う。

- registry validation
- network probe または deterministic fixture probe
- observation、想定 state transition、count/identity gate report
- candidate generationとvalidation（Actions artifact まで）
- Git diff summary と「昇格した場合に変わる path」の表示

dry-run は state commit、catalog commit、push、Pages release、Slack/email 通知を行わない。少なくとも全対象 venue で
`unavailable`、`partial/stabilizing`、または公式公開済み snapshot のいずれかを観測し、fixture test と live report の
差異を review した後、別 PR で `apply_enabled` を有効化する。有効化は GitHub Actions / branch protection / Pages の
外部 gate 確認とユーザーの明示承認を必要とする。

初回 rollout は OpenReview の ICLR / NeurIPS / ICML に限定する。CVF と ACL Anthology は adapter ごとの完全取得・
partial failure 契約を追加してから別段階で有効化する。ECCV は ECVA adapter がないため対象外のままとする。

---

## 10. Catalog と lineage / slides の分離

catalog の publication success は lineage または slide deck の生成成功を要求しない。

- 新規 edition には空 graph を「系譜あり」と表示しない
- conference lineage は別 producer が生成し、`availability=ready` かつ `audit_status=passed`、artifact hash binding を
  満たすまで通常導線に出さない
- lineage の LLM key 不在、外部 API 失敗、人手 fixture 未承認は catalog release を止めず、既存 lineage を保持するか
  `unavailable/unknown` とする
- release watch が lineage build を直接起動する場合も、catalog candidate と別 job / artifact / status にし、失敗を
  catalog promotion 成否へ混ぜない。v1 rollout では直接起動しない
- slide deck は一論文単位の明示 request であり、新規 catalog 全件を自動生成しない
- catalog row に canonical `paper_id` と trusted source/PDF が加わることで slide CTA の入力候補にはなるが、
  `slide-deck-v1` の provisional生成、human review、公開 gate は [`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md)
  に従う

---

## 11. Failure taxonomy と通知

stable machine code は少なくとも次を持つ。

```text
CONF_REGISTRY_INVALID
CONF_EDITION_OUT_OF_RANGE
CONF_SOURCE_UNAVAILABLE
CONF_SOURCE_RATE_LIMITED
CONF_SOURCE_TIMEOUT
CONF_SOURCE_HTTP_ERROR
CONF_SOURCE_PARSE_ERROR
CONF_SOURCE_PARTIAL
CONF_SOURCE_FINGERPRINT_CHANGED
CONF_COUNT_BELOW_MINIMUM
CONF_COUNT_ABOVE_MAXIMUM
CONF_COUNT_SHRINK
CONF_IDENTITY_MISSING
CONF_IDENTITY_CONFLICT
CONF_DUPLICATE_ID
CONF_CANDIDATE_MISMATCH
CONF_PROMOTION_CONFLICT
CONF_VALIDATION_FAILED
CONF_RELEASE_FAILED
```

`unavailable`、`partial`、`stabilizing`、unchanged は通常状態であり workflow failure にしない。timeout / 429 / 5xx は
bounded retry 後に probe failure とし、state を進めない。identity conflict、shrink、wrong source、candidate mismatch は
fail closed の anomaly とする。

全 run は GitHub Step Summary に edition、phase、件数、fingerprint の短縮表示、gate result、changed/no-op を出す。
失敗通知は Actions failure と既存の承認済み通知 channel に限定し、同一 edition / error code の通知を一定時間抑制する。
通知本文に secret、HTTP header、response body、author/title 全件、query URL、raw exception を含めない。通知 channel の
secret が無い場合も workflow 本体を失敗させず、Actions summary を正本とする。

---

## 12. Security、resource、cost contract

- 外部通信先は adapter ごとの exact HTTPS host allowlist に限定する。redirect は各 hop を再検証し最大 3
- userinfo、IP literal、非既定 port、private/link-local/metadata address、proxy env、`.netrc`、cookie を拒否
- connect 10秒、read 30秒、request total 60秒を既定上限とし、429 / 5xx / network error は jitter 付き最大 3回 retry
- OpenReview page size は API 上限以下、最大 25 pages / 25,000 notes、総 response 128 MiB、job 20分を hard limit とする
- rate-limit header を尊重し、probe と collect を無制限に並列化しない。同一 source は直列、edition 間も bounded concurrency
- raw body、token、environment、request header を log / state / candidate に書かない
- registry text と upstream metadata は shell command に連結せず、argv または structured API parameter として渡す
- upstream title / abstract / author / label は untrusted text とし、HTML 生成では text escaping、JSON では strict serialization
- Actions は pinned SHA、`uv sync --frozen`、最小権限、timeout、artifact retention、explicit path allowlist を使う
- OpenReview v1 は API fee 0 を前提とするが、request/page/note 数と wall time を run summary に記録する。将来有料 source を
  加える場合は venue/run/month budget と hard stop を registry 外の運用設定で追加する
- API key が不要な source に GitHub以外の secret を渡さない。GitHub token も probe HTTP requestへ渡さない

---

## 13. 実装タスク

### R1 — pure domain / fixtures

1. registry runtime validator、JSON Schema、`{year}` bounded expansion
2. edition planner と active-window filter
3. OpenReview strict adapter、canonical normalization、fingerprint
4. pure readiness reducer と state schema
5. count / identity / duplicate / shrink gate report
6. deterministic fixture と CLI dry-run report

### R2 — candidate integration

1. official adapter output を既存 summary / pages projection へ接続
2. source snapshot fingerprint と observation timestamp の生成物 binding
3. changed-only candidate packaging、global projection 再生成、allowed path 定義
4. new edition scaffold の deterministic display/lede。upstream textを lede HTML として使わない
5. conference source quality report と run manifest

### R3 — workflow dry-run

1. scheduled/manual trigger、concurrency、read-only probe/generate jobs
2. candidate artifact、Step Summary、failure classification
3. live dry-run 観測と request count / latency 計測
4. branch protection、required checks、Pages exact-SHA release 接続の外部監査

### R4 — apply

1. CAS state writer と state-only no-release path
2. fresh-tip conference promotion と exact-SHA release handoff
3. deduplicated failure notification
4. post-deploy smoke と known-good rollback 運用確認

R1–R3 の実装・fixture検証と、R4 の外部 apply 有効化は別変更単位にする。

---

## 14. 受入テスト

### Registry / planning

- valid ICLR / NeurIPS / ICML entries、current/next year、active/inactive month
- duplicate venue、unknown adapter、invalid slug、`daily`、複数 placeholder、式展開、future bound 超過を拒否
- registry にない venue/source ID を workflow input から指定できない

### Adapter / fingerprint

- 404、200 empty、one page、multi-page、最終 page、429→retry、timeout、5xx、invalid JSON
- page 途中 failure / max page / max byte は partial rows を返さず失敗
- mismatched venueid、withdrawn/rejected、unknown decision label、missing note ID を検証
- page 順・response 順が違っても同一 fingerprint、field変更では別 fingerprint
- native identity coverage 100%、duplicate/conflicting alias を拒否

### Readiness reducer

- 404→unavailable、positive below min→partial、初回valid→stabilizing
- 同一 run retry は stable count を増やさない
- min separation 未満、max separation 超過、fingerprint変化、transient failure
- 異なる scheduled run の同一 fingerprint 2回だけ ready
- generator 再取得 mismatch で ready を解除
- unchanged published fingerprint は no-op
- published count shrink / native ID removal は anomaly、追加とmetadata correctionは再安定化
- state reducer と serialize が同一入力で byte-identical

### Candidate / promotion / release

- count floor/ceiling、previous-edition ratio、CSV/summary/papers件数不一致
- identity/search/detail/conferences projection整合と snapshot/fingerprint binding
- candidate path traversal、symlink、unexpected path、base SHA以降の同一path変更を拒否
- validation failure で commit/state published fields/release が不変
- no diff は `changed=false` で Pages releaseなし
- promotion race は bounded retry後に再生成要求、古いcandidateで上書きしない
- release input は promoter の40桁 exact SHAだけ、deployは一要求一回
- lineage unknown/failed と slide未生成でもcatalogだけ成功し、通常系譜棚・deck公開へ混入しない

### Security / operations

- host allowlist、redirect、private IP、userinfo、oversize、timeout、secret scan
- schedule no-op を failure通知しない、同一failure通知をdedup
- dry-run は repository/state/Pages/通知を変更しない
- workflow root/job permissions、pinned actions、timeouts、frozen lockを静的検査

---

## 15. 外部 gate と完了条件

ローカル実装完了は次を全て満たすこととする。

- R1/R2 の unit・contract・integration test が network-free fixture で成功
- workflow YAML、permissions、candidate allowlist、promotion/exact-SHA handoff の静的 test が成功
- live dry-run の件数、pagination、latency、request cost、failure分類を対象 venue ごとに記録
- dry-run で外部 write、dispatch連鎖、push、Pages deploy、通知を行っていない
- lineage / slides が catalog success 条件から分離されている

本番自動更新確認済みと称するには、別途ユーザー承認の上で次の外部 gate が必要である。

1. GitHub Actions schedule と state/promotion job の権限、branch protection、required checks を確認
2. apply を有効化し、2 probe readiness から candidate、promotion、exact-SHA Pages release を一件 end-to-end 実行
3. 公開 `conferences.json`、catalog、search、paper link、snapshot date、deployment marker を smoke
4. unchanged 次回 run が commit / deploy なしの no-op になることを確認
5. 意図的な fixture failure または安全な dry-run failure で通知・既存公開保持を確認
6. known-good exact SHA rollback の手順と担当者を確認

workflow dispatch、schedule 有効化、push / merge、Pages 公開、通知、secret・repository設定変更は、この契約書の作成や
ローカル実装だけでは許可されない。外部 gate ごとに明示承認を得る。
