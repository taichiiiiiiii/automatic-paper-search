# 34. 学会の前年度 baseline / ratio ローカル評価

- 作成日: 2026-09-06
- 状態: snapshot共有検査・baseline結合・pure assessment API・report Schema/exportをローカル実装済み。CLI、workflow、trusted state/CAS、実 source による検証・公開接続は未実装
- 上位契約: [19](19-conference-release-watch-contract.md)、[31](31-private-review-and-conference-candidates.md)、[32](32-local-update-and-review-intake.md)
- 現行コード: [models.py](../../paperpilot/conference_watch/models.py)、[registry.py](../../paperpilot/conference_watch/registry.py)、[stability.py](../../paperpilot/conference_watch/stability.py)、[candidate.py](../../paperpilot/conference_watch/candidate.py)、[dry_run.py](../../paperpilot/conference_watch/dry_run.py)
- 対象外: live 収集、永続 state の認証、CAS、staging、公開、workflow dispatch、初年度の人手承認

## 1. 目的と現在の不足

[19](19-conference-release-watch-contract.md) は、同じ venue の直近 published edition の件数を基準に
前年度比の下限・上限を検査することを要求する。現在の
[`stability.observation_from_detection`](../../paperpilot/conference_watch/stability.py) は
`previous_edition_count: int | None` を受け、下限・上限の計算自体は行うが、その整数が対象 venue の
published state と実 catalog から得られたことを結合しない。

2026-09-06の定期照合で、現行APIの入力検証にも不足を再現し、後続の限定修正で解消した（§9の履歴）。
これは将来のassessmentでstate/catalogを結合するだけでは解消しない。

[31](31-private-review-and-conference-candidates.md) の C3a と
[32](32-local-update-and-review-intake.md) の C3b/C4a は、この不足を理由に candidate の
`source_quality.gates.previous_edition_ratio` と dry-run report の同名 gate を
`not_checked` のままにしている。この判断は正しく、本設計の最初の実装単位だけでは変更しない。

次の限定単位は、bounded なローカル入力だけから前年度 baseline の内部整合を検査し、比率の計算結果を
immutable な assessment bytes にする pure API とする。ファイルを読まず、state を更新せず、候補や公開物を保存しない。

## 2. 用語と既存フィールド

フィールド名は現在の `paperpilot.conference_watch.models` に合わせ、似た名前を新設して意味を混ぜない。

- 前年度の公開済み source fingerprint は `EditionState.published_fingerprint` である。
  `published_source_fingerprint` というフィールドは現在の runtime model には存在しない。
- 前年度の公開済み件数は `EditionState.published_count`、公開済み native ID 集合は
  `EditionState.published_source_ids` である。
- 現年度 snapshot の fingerprint は `SourceSnapshot.source_fingerprint` である。
- 現年度の安定確認中の fingerprint は `EditionState.stable_fingerprint` だが、この assessment は
  readiness state を作らず、current snapshot の再検証だけを行う。
- [19](19-conference-release-watch-contract.md) の概念 state にある `published_source_sha` は、現行
  `EditionState` にはまだ実装されていない。これを `published_fingerprint` や catalog SHA と同一視しない。
- 前年度 catalog の SHA-256 は、この assessment が `previous_catalog_bytes` の実 byte から計算する
  ローカル binding である。永続 state が真正であることや、その catalog が実際に公開された byte であることは証明しない。

## 3. 限定 API

初回 API は以下で実装した。package直下からimport可能。レポートは`schemas/conference-baseline-assessment-v1.schema.json`に従う。

```python
def assess_previous_edition_ratio(
    registry: ConferenceRegistry,
    edition: Edition,
    snapshot: SourceSnapshot,
    previous_state: EditionState,
    *,
    previous_catalog_bytes: bytes,
) -> PreviousEditionRatioAssessment: ...
```

返却値は frozen dataclass とし、少なくとも次の immutable 値だけを持つ。

```python
@dataclass(frozen=True)
class PreviousEditionRatioAssessment:
    status: str
    previous_edition_id: str
    previous_year: int
    previous_count: int
    current_count: int
    effective_minimum: int
    effective_maximum: int
    previous_catalog_sha256: str
    published_fingerprint: str
    current_source_fingerprint: str
    report_bytes: bytes
```

`status` は初回実装では `passed`、`below_minimum`、`above_maximum` の閉じた集合とする。
invalid input、初年度、baseline 不在を成功結果へ変換せず、sanitized な専用 `ValueError` subclass で拒否する。
例外の code と message は固定 code のみとし、title、author、abstract、path、raw JSON、例外本文を含めない。

`report_bytes` は canonical UTF-8 JSON + LF とし、入力から決定論的に生成する。wall clock、乱数、入力 path は
含めない。件数、edition ID、年、fingerprint、catalog hash、effective bounds、status と、すべて false の
authority を含める。論文 title、author、abstract、native source ID の全件リストは含めない。

## 4. Registry / state / catalog / snapshot の結合

assessment は次を全件検査し、一つでも失敗すれば部分的な評価を返さない。

### 4.1 Registry と edition

- `registry` 内で `edition.venue_key` に一致する venue は一件だけであること。
- current `edition` の edition ID、year、display name、adapter、source ID、count gate、track policy、
  separation bounds が registry の template/defaults から導かれる値と一致すること。
- v1 baseline は同じ venue の直前年だけを扱い、`previous_state.year == edition.year - 1` を要求する。
- 前年度の edition ID は registry の `slug_template` を `previous_state.year` で展開した値と一致すること。
- disabled venue や `registry.apply_enabled == false` でもローカル assessment は可能だが、それらを
  apply/publication 許可へ読み替えない。

直前の calendar year に published edition が存在しない venue で、さらに古い「直近 published edition」を
探索する規則は初回範囲では未決事項とする。年を飛ばして任意 baseline を採用しない。

### 4.2 Previous published state

- `previous_state.phase is ReadinessPhase.PUBLISHED`。
- `previous_state.venue_key == edition.venue_key`、year と edition ID は 4.1 の導出値と一致する。
- `published_count` は bool でない整数で、1 以上 25,000 以下。
- `published_source_ids` は tuple、件数は `published_count` と一致し、全件が OpenReview native ID の
  bounded pattern に合い、重複しない。
- `published_fingerprint` は64文字の lowercase SHA-256 hex。
- `last_observation` や安定観測時刻が存在することを、この assessment 単独で published state の真正性として
  要求しない。durable state parser と CAS 証拠は後続 gate である。

### 4.3 Previous catalog bytes

- exact `bytes`、16 MiB 以下、1–25,000行の strict UTF-8 JSON。UTF-8 BOM、UTF-16/32、duplicate key、
  NaN/Infinity、過深、unpaired surrogate を拒否する。
- 行は C3b dry-run と同じ閉じた15項目、text/array/metric 上限、canonical OpenReview forum/PDF URL、
  `source=openreview`、empty `arxiv_id`、native identity と deterministic paper ID の一致を要求する。
- paper ID と source ID は一意。title による merge や dedup は行わない。
- catalog 行数は `previous_state.published_count` と完全一致する。
- catalog の source ID 集合は `previous_state.published_source_ids` と完全一致する。順序は binding の真偽に
  影響させないが、SHA-256 は raw input bytes に対して計算する。

同じ validation を複製しないため、初回は `conference_watch.dry_run._validate_catalog` を
package-internal helper として直接再利用する。循環import等の実証された必要がある場合だけ別moduleへ抽出する。
現在の helper は mutable な list/dict を返すため、その値を
public result に露出せず、この API では件数と ID 集合へ直ちに縮約する。抽出によって既存 dry-run の error code、
上限、candidate validation、出力 byte を変えてはならない。

### 4.4 Current snapshot

- snapshot schema、edition ID、adapter/version、source ID は current `edition` と一致する。
- rows は tuple、1–25,000件。request/page/response byte、unknown decisions、duplicate title count は
  C3a と同じ bounds を満たす。
- native identity、canonical URL、paper ID、source ID uniqueness、必須 title/authors、decision policy を
  C3a と同じ規則で再検証する。
- `source_fingerprint(...)` を全 normalized rows から再計算し、`snapshot.source_fingerprint` と一致させる。
- `current_count` は caller の整数ではなく、検証済み `len(snapshot.rows)` から導出する。

C3a の検証ロジックも無断で簡略化・複製しない。候補 build に readiness が必要なため、assessment から
架空の ready state を作って `build_catalog_candidate` を呼ぶことは禁止する。実装済みのprivate共有seam
`candidate._validate_candidate_snapshot`は`_validate_edition`、
`_validate_snapshot_header`、`_validated_rows`と、その後のunknown/duplicate統計一致・fingerprint再計算一致までを含める。
`_validated_rows`だけでは統計値とfingerprintの検査は完結しない。`minimum_absolute`による拒否とreadiness検査は
candidate側に残す。assessmentでは下限未満も`below_minimum`という評価結果にするためである。
既存C3aの外部API・error code・candidate bytesを変えないことを回帰テストで保証する。

## 5. 比率境界

[19](19-conference-release-watch-contract.md) と現行 `stability.observation_from_detection` に合わせ、次を使う。

```text
effective_minimum = max(
  edition.count_gate.minimum_absolute,
  floor(previous_count * edition.count_gate.previous_edition_min_ratio),
)
effective_maximum = ceil(
  previous_count * edition.count_gate.previous_edition_max_ratio
)
```

- `current_count < effective_minimum` は `below_minimum`。
- `current_count > effective_maximum` は `above_maximum`。
- 両境界を含む範囲内は `passed`。
- 上限超過は「より完全なので合格」ではなく、[19](19-conference-release-watch-contract.md) どおり人手確認が必要な anomaly 候補。
- 下限未満は partial 候補。count gate は完全性の証明ではなく、明白な partial/wrong source を止める補助 gate である。
- ratio は registry の有限な正数を使い、bool、NaN/Infinity、0以下、過大値、min > max を拒否する。

初回実装は現行のPython二進floating pointと`floor`/`ceil`の互換を維持し、境界値のbyte-for-byte回帰を固定する。
registry ratioをdecimal文字列へ変更する場合は別の仕様変更として扱い、このassessment追加と混在させない。

## 6. First edition と不正 baseline

registry の `first_year` と current edition year が同じ場合、前年度 baseline は存在しない。このケースを
ratio `passed` にせず、専用 code で「この API の対象外」として拒否する。初年度の
`minimum_absolute` と `first_edition_human_dry_run` は別契約であり、本 assessment は人手承認を生成しない。

baseline が未指定、直前年でない、別 venue、未公開 phase、count/ID/fingerprint が欠損、不一致、重複、
catalog が空・不正・過大な場合も fail closed とする。より古い catalog の自動 fallback、`docs/conferences.json` の
集計件数だけへの fallback、title-based join、current snapshot count の書換えは行わない。

実 repository の `docs/<edition>/papers.json` や `docs/conferences.json` はこの pure API 自身では開かない。
caller が渡す exact bytes はローカル整合を検査できるだけで、Git provenance、fresh tip、実 deployment を証明しない。

## 7. Report の authority

assessment report の authority は少なくとも次をすべて false とする。

- `trusted_persistent_state_proof`
- `baseline_state_trusted`
- `fresh_tip_checked`
- `staging_materialized`
- `promotion_authorized`
- `publication_authorized`

`status=passed` は「与えられた bounded state/catalog/snapshot が内部整合し、件数が設定範囲内」という意味だけである。
公式 source の完全性、state の出所、branch tip、初年度承認、公開可能性を意味しない。

## 8. 必須テスト

すべて synthetic fixture とし、network、filesystem、subprocess、Keychain、外部 API を使わない。

1. 同じ入力で frozen result と report bytes が完全一致し、入力を変更しない。
2. lower boundary、upper boundary は `passed`、1件下は `below_minimum`、1件上は `above_maximum`。
3. `minimum_absolute` が ratio floor より大きい場合の下限、ratio ceil の非整数境界。
4. current edition と previous state の venue/year/derived edition ID の一致。
5. previous state が PUBLISHED で、published count/source IDs/fingerprint が完全であること。
6. bool count、負数、25,000超、重複/不正 source ID、count/ID件数不一致を拒否。
7. previous catalog の malformed JSON、duplicate key、非UTF-8/BOM/UTF-16/32、NaN、過深、空、oversize、
   extra/missing key、bool metric、duplicate identity、URL/paper ID mismatch を拒否。
8. catalog count/source ID 集合と previous state の不一致を拒否。catalog row orderだけでは集合一致を壊さず、
   raw byte SHA は変わることを確認。
9. current snapshot の header/fingerprint/count/identity/duplicate/decision/bounds 異常を拒否。
10. same-title/different-ID は別論文として数え、title で baseline を結合しない。
11. report に title、author、abstract、raw catalog、path、例外本文を含めない。
12. report の全 authority が false で、ファイル・socket・subprocess I/O がない。
13. first edition、baseline 不在、別 venue、直前年でない state は `passed` にしない。
14. 既存 stability、candidate、dry-run の direct/integration tests が不変で、既存 output bytes が変わらない。

## 9. 後続 gate と未決事項

2026-09-06の「実装を全て」依頼で、pure assessmentをCloud実装へ委譲した。
限定入力の79件の回帰とRuffを確認し、隔離branchだけへ準備commitを作成した。
Qwenは資料読込とコンテキスト圧縮/再開を繰り返し、runtime/testの変更を返さなかったため、
所有jobを停止した（終了130）。source worktree clean、残存workerなしを確認し、実装は未採用のまま。
archive原本・main WIP・共有queue設定には触れず、candidate/dry-runの`not_checked`も変更していない。
後続はsnapshot共有helper・registry/state結合・report生成をさらに小さな単位へ分ける必要がある。

本 assessment の初回実装後も、C3a `source_quality.gates.previous_edition_ratio` と C3b/C4a dry-run report の
同名 gate は `not_checked` のままとする。assessment object や caller の boolean を渡すだけで `passed` に変えない。

`passed` を candidate に伝播する後続単位では、少なくとも次を別途設計・実装する必要がある。

1. assessment report の SHA/size と previous catalog SHA を ProbeObservation に結合するか、別の closed evidence
   envelope として durable state に保持する方法。
2. 二回の qualifying observation が同じ previous baseline assessment に基づくことの検証。
3. `EditionState` serialization/Schema、C3a readiness validator、source quality、run binding、C3b dry-run report への
   一方向 hash binding。Schema migration と後方互換方針。
4. durable state を trusted source から strict parse し、fresh tip 上で CAS 検証する単一 writer。
5. 初年度の人手 dry-run 記録、staging、catalog date、共有 search/details/identity projection、promoter、exact-SHA release。

未決事項は次のとおり。

- 年が欠ける venue で、直前 calendar year ではなく「直近 published edition」を安全に選ぶ state collection API。
- `published_source_sha` を実装する場合の対象 byte、保持場所、既存 `published_fingerprint` との関係。
- 後続でratioのdecimal表現と丸めを現行float契約から変更するか（初回は互換を維持する）。
- assessment evidence を ProbeObservation に内包するか、独立 artifact として state から参照するか。
- package-internal catalog/snapshot validator の配置と、既存 error code を維持する抽出方法。

### 2026-09-06確認: 既存count APIの入力検証（当初P2・後続で修正）

`stability.observation_from_detection`の`previous_edition_count`は、非Noneなら負数判定だけを行い、
plain-int型や有限の上限を強制せずfloat ratioとの乗算へ進む。
syntheticな3件snapshot/`CountGate(1, 0.7, 1.5)`で`True`を渡すと拒否せず`anomaly`を返し、
`10**10000`では固定codeの例外ではなく`OverflowError`になることを親・独立担当が再現した。
実source、ネットワーク、永続state、公開への接続はこの再現に使っていない。

assessmentとは別の限定修正で、既存APIにbounded plain-int検証と安全なerror契約を追加する必要がある。
bool・非整数・負数・過大整数の回帰を追加し、正常な件数の既存結果・丸め・2回観測契約は維持する。
assessment側は1〜25,000件を要求するが、既存APIが現在許す0を拒否するか、baseline未指定のNoneと
どう区別するか、上限をsourceの25,000件に合わせるかはcallerの互換性を調べてから確定する。
0、25,000、25,001と極端な整数は、その確定した契約の境界テストに含める。
このメンテナンスではruntime/testを変更しておらず、入力不足を修正済みとはしない。

後続の直接実装依頼では、このP2だけを独立したCloud小単位にする。既存APIとの互換性から
`None`またはplain `int`の0〜25,000を許可し、bool/非整数/負数/上限超過を固定
`ValueError("previous_edition_count_invalid")`で拒否する。run_id検証直後、result分岐前に検証するため
UNAVAILABLE/ERRORでも不正引数は拒否する。正常値の比率計算・丸め・出力は変更しない。
assessment本体やcandidate/dry-runの`not_checked`、定期実行・公開の有効化はこの修正に含めない。

この限定修正はQwen Cloud `qwen3.7-plus`へ委譲して採用した。runtimeはrun_id検査直後のguard追加と
旧negative-only guardの削除だけ。bool/int subclass/非整数/負数/25,000超を、float乗算前に固定codeへ閉じる。
親が生成テストの存在しないresult属性とUNAVAILABLE fixtureのerror_code不足、正規表現表記を補正した。
旧runtimeへ戻した実REDは22 failed / 5 passed、修正runtimeで新27件＋既存stability10件は37 passed。
主作業のcandidate/dry-run/integrationを含めた関連123件も成功し、対象Ruff/narrow mypy・独立レビューで指摘なし。
None/0/25,000/2と前年2・現年4の既存判定、入力非変更を確認した。assessment全体を実装した結果ではない。

これらを解決するまで、local assessment の成功を trusted readiness、staging、promotion、publication の認可として
扱わない。

## 10. 次回Qwen実装への分割（2026-09-07定期照合）

前回の読取反復を踏まえ、次の4単位を一度に実装させず、各単位のレビュー指摘をQwenへ戻してから次へ進む。
unit 1は後続の直接依頼で採用した（§11）。unit 2〜4は依頼準備であり、baseline API/Schemaの実装記録ではない。

1. **採用済み: current snapshotの共有検査だけ。** `candidate.py`の§4.4の範囲をprivate seamへまとめた。
   呼出元のexact型検査、minimum/readiness/公開済みID連続性は維持する。header/row/統計/fingerprintの拒否と
   candidateの既存error/全出力bytes不変を検証し、下限判定を共有seamへ混ぜない。
2. **previous baselineのprivate検査だけ。** 新assessment moduleでregistry/current editionの導出一致、直前年、PUBLISHED、
   bounded count/一意ID/fingerprintを照合し、既存`dry_run._validate_catalog(..., prefix="previous_catalog")`でcatalogを検証する。
   件数・ID集合一致とraw SHAへ縮約する。`plan_editions`は有効venue/現在月を選別するためローカル評価の代用にしない。
   disabled venueの評価、初年度拒否、全mismatch・固定error・入力無変異を検証する。
3. **public assessmentとreportだけ。** 先行2単位を使い、3状態、inclusiveなfloor/ceil境界、frozen result、
   canonical JSON+LF、本文/全件ID非出力、全authority falseを実装する。最小値優先・整数境界・非整数ceil・
   決定性・no I/Oを直接検証する。API名とreportの閉じたキー一覧を依頼書で固定してから生成する。
4. **package/Schemaと統合回帰。** 採用済みreportのSchema、必要な公開export、同梱確認を追加し、
   stability/candidate/dry-run/registryを再検証する。CLI・workflow・live収集・trusted state/CAS・公開接続は含めず、
   candidate/dry-runの`previous_edition_ratio=not_checked`を維持する。

既存catalog parserの過深拒否は`strict_json_loads`が送出する`RecursionError`等に依存し、固定数値の深さ制限ではない。
固定depth capの導入は既存エラー互換とともに別の入力境界課題として記録し、現行実装に存在すると主張しない。
今回のheartbeatではCloud起動の対話opt-inを推測せず、調査・依頼準備のみを継続した。runtime/test/Schemaは変更していない。

## 11. 2026-09-07 直接依頼: Qwen実装・レビュー・修正の反復

unit 1だけをQwen Cloud `qwen3.7-plus`へ委譲し、親と別のSolが差分・受入条件を独立検査した。
初回の自律編集はpatchに失敗し、禁止した依存installも試みたため、所有workerを停止した（終了130）。
installは失敗し、隔離worktreeの変更は空だった。次に同モデルへtool実行なしのソース限定で依頼し直し、
正常終了・tool呼出し0の返却を得た。diffのhunk/fence表記だけを機械補正し、生成されたruntimeは意味を変えず採用した。
共有queue・provider・既存依存・主作業のAGENTS/既存WIPは変更していない。自律実装の安定性を確認した結果ではない。

- `candidate._validate_candidate_snapshot`はexact Edition/SourceSnapshot型検査に続けて既存のedition/header/rows/
  統計/fingerprint検査を実行し、既存の3要素tupleを返す。build冒頭の3型検査とerror順序は不変。
- minimum_absolute/readiness/公開済みID連続性とserializationはcandidate側に残し、5種類の出力byteのSHAを変更前と照合した。
  `previous_edition_ratio=not_checked`と公開非認可は不変。新しい外部APIではないためREADMEは変更しない。
- 親の独立テストは先行22 failed / 1 passedから、追加のsubclass・no I/O検証も含め25 passedになった。
  主作業の学会関連162件、独立監査側104件が成功し、P1/P2なし。対象Ruff/format/narrow mypyも成功。
- 最終host補助の全体回帰は3,029 passed / 1 skipped（45.75秒、Linux専用RLIMIT_AS）。全体Ruffとasset同期は成功。
  全体mypyは268 errors / 46 files / 280 source filesで未成功。Docker/runtime/CI、実source、公開の検証ではない。
- runtime/独立テストは主作業へ機械適用済み。primary commit/pushはしておらず、所有Qwen workerは終了済み。
  隔離準備HEADは`7287660`。次はunit 2のregistry/state/catalog結合であり、assessment全体の完成ではない。

### 次のunit 2への受入条件補足（未実装）

typed registryの手作り値も不正入力として扱う。exactなdomain dataclass・tuple長・boundedなplain leafを先に検査し、
固定キーの手動dict/list投影を64 KiB以内のcanonical bytesへ制限してから`parse_registry`で再検査する。
無制限の`asdict`/`public_dict`や`plan_editions`は使わない。巨大ratioの`OverflowError`等も専用の固定codeへ閉じる。
registryの`_edition`でcurrent/直前年を導出し、disabled venueでもローカル照合できること、初年度は拒否することを検証する。
既存catalog validatorのmutable結果は件数・ID集合・raw SHAへ縮約し、本文やID全件を返却しない。
具体的なprivate API名・閉じたerror code一覧は次回のbounded依頼前に確定する。

## 12. 2026-09-08 単独ループ実装の計画

最新のSingle-agent指示を優先し、以下は親がテスト先行→実装→自己レビュー→回帰確認で順番に進める。
Qwenや他のsubagentは起動しない。許可範囲は新`baseline.py`、対応テスト、report Schema、package exportと利用文書。

1. `_validate_previous_baseline`でregistry再検査・current edition導出一致・直前年PUBLISHED state/catalog結合を実装。
2. `assess_previous_edition_ratio`で共有snapshot検査、既存float floor/ceil、frozen result、canonical reportを接続。
3. 閉じた`conference-baseline-assessment-v1` Schemaと受入・既存candidate/dry-run回帰で検証する。

例外は`PreviousEditionRatioAssessmentError`、固定codeは`CONF_BASELINE_`に続く
`INPUT_INVALID`/`REGISTRY_INVALID`/`EDITION_MISMATCH`/`FIRST_EDITION`/`STATE_INVALID`/
`CATALOG_INVALID`/`CATALOG_MISMATCH`/`SNAPSHOT_INVALID`とする。
reportのキーはschema_version、scope、edition_id、venue_key、year、status、previous_edition_id、previous_year、
previous_count、current_count、effective_minimum、effective_maximum、previous_catalog_sha256、published_fingerprint、
current_source_fingerprint、authorityのみ。scopeはlocal_assessment_only、authorityは§7の6項目すべてfalse。
CLI・実source・永続state/CAS・workflow・Docker・公開は対象外。candidate/dry-runのnot_checkedを維持する。

### 単位1（旧unit 2）の実装・自己レビュー結果

`baseline._validate_previous_baseline`を親が直接実装した。typed registryをboundedなplain leafから再構成して
再parseし、current editionの全導出値、直前年PUBLISHED state、catalogの件数・ID集合を結合する。
返却はfrozenな件数・年・edition ID・fingerprint・raw catalog SHAのみで、本文・全件IDは返さない。
disabled venueも評価可能だが初年度は拒否する。固定error code以外の入力値を例外文へ出さない。

テスト先行の54件に加え、自己レビューで不完全なdataclassの属性欠落を固定エラーへ閉じる修正と、
registryの重複・巨大文字列・不正UTF-8・template・list入力の回帰を追加し、62件が成功した。
対象Ruff・format・modelsを含む3ファイルのscoped mypyは成功。`paperpilot`全体のRuffとasset同期・diff checkも成功。
全体mypyは268 errors / 46 files / 282 source filesで未成功。
host補助の全体pytestは3,091 passed / 1 skipped（45.88秒、Linux専用RLIMIT_AS）で成功。
これはDocker/production runtimeの検証ではない。
なおrepository rootの`ruff check .`では、今回未変更の非稼働runner/test内にimport順の2件が残る。

この単位はprivate検査のみである。public assessment、ratioの3状態判定、report Schema/exportは次の未完了作業。
READMEの利用方法は変更していない。公開認可・candidate/dry-runのnot_checked・Dockerゲートは変更せず、commit/pushなし。

### 単位2・3: public assessment / report

`assess_previous_edition_ratio`を公開し、private baseline検査と既存snapshot共有検査を接続した。
検証済み行数から現年度件数を導出し、既存のbinary float floor/ceilとinclusiveな境界を維持する。
absolute minimumがmaximumを超える場合も既存ルール同様に下限未満判定を優先する。
frozen/slots resultとcanonical UTF-8 JSON + LFを返す。全6 authorityはfalse、本文・著者・全件IDは出力しない。
report Schemaは余分なkey・欠損・authorityのtrueを拒否する。Schemaはrepository内の検証用であり、wheelへの同梱を主張しない。

テスト先行15 failedから15 passed、Schema/exportと属性欠落の自己レビュー回帰を加えて専用17件が成功。
既存candidate/dry-runのnot_checkedと公開認可は未変更。次は信頼できる永続stateとGit来歴/CASの設計・実装であり、
このAPIのpassedをそれらの代用にしてはならない。CLI・workflow・実source・Docker・公開は今回実施していない。

自己レビュー後にsame-title/different-ID・順序不変・入力非変更・public APIのouter型拒否を追加し、専用22件、
baseline/snapshotを含む109件が成功した。追加5件の前に開始した全体pytestは3,108 passed / 1 skipped
（47.92秒、Linux専用RLIMIT_AS）で成功。全体Ruff（paperpilot）、対象scoped mypy、asset同期・diff checkも成功。
全体mypyは268 errors / 46 files / 283 source filesで引き続き未成功。検証はhost補助のみで、commit/pushしていない。
