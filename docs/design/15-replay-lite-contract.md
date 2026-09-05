# 15. Replay Lite R0 実装契約

- **更新日:** 2026-08-30
- **状態:** 実装可能
- **対象:** 決定論的 byte 生成、run manifest、短期 artifact 検証、network-free fixture replay
- **非対象:** collector 全体の replay、長期 CAS/R2、workflow 配線・公開

この文書は Replay Lite R0 の producer、validator、CLI、test が共有する実装契約である。
R0 は任意の過去 pipeline を再実行する仕組みではない。retention 内の凍結入力と、コード内へ
明示登録した純粋 projector に限定して、出力 byte の再現性を検証する。

## 1. 保証範囲

1. JSON / JSONL を canonical byte 列へ変換する。
2. canonical byte 列を決定論的 gzip byte 列へ変換する。
3. 保存・upload した実 byte 列の SHA-256 を manifest に記録し、実行前に検証する。
4. manifest と凍結入力が有効な場合だけ、登録済み projector を network-free で実行する。
5. output の byte 数・SHA-256 が全件一致した後だけ atomic publish する。
6. missing / expired / hash mismatch / dependency mismatch を異なる error code で報告する。

R0 では `PipelineRunner.run()`、collector、signal/LLM API、exporter、seen IDs、run history、cache、
任意 Python import、manifest 指定 command を実行しない。workflow 接続は R1/S2 とする。

## 2. 実装境界

```text
paperpilot/replay/{__init__,canonical,manifest,artifacts}.py
paperpilot/scripts/replay_run.py
schemas/run-manifest-v1.schema.json
paperpilot/tests/test_replay_{canonical,manifest,run}.py
paperpilot/tests/fixtures/replay-lite-r0/
```

runtime validator は標準ライブラリで `manifest.py` に実装する。JSON Schema は CI と他言語 consumer 用で、
wheel 実行時に repository root や `jsonschema` package を要求しない。

## 3. Canonical byte contract

### 3.1 JSON / JSONL

```python
def canonical_json_bytes(value: object) -> bytes: ...
def canonical_json_sha256(value: object) -> str: ...
def canonical_jsonl_bytes(records: Iterable[object]) -> bytes: ...
```

- UTF-8、BOM なし、末尾 LF は正確に一つ
- `ensure_ascii=False`、key 辞書順、separator は `(",", ":")`、`allow_nan=False`
- Unicode normalization は行わず、非 JSON 型を暗黙変換しない
- JSON parse 時は duplicate key を拒否する
- JSONL は各 record を同じ canonical JSON として連結し、空 iterable は `b""`

```text
value:  {"b":1,"a":"あ"}
bytes:  {"a":"あ","b":1}\n
sha256: 58968931db66c950c32a1c8e1c1bf41c7e86a3deae3bb09990c242c3d1886b87
```

`paperpilot/scripts/_lineage_contract.py` の既存 hash は末尾 LF を含まない別契約である。
P2 の意味を変えず Replay helper と分離する。

### 3.2 deterministic gzip

`gzip.GzipFile(filename="", compresslevel=9, mtime=0)` を使い、mtime `00000000`、filename field なし、
OS byte `255` を固定する。manifest の SHA-256 は展開後 JSON ではなく保存した gzip byte へ付ける。

```text
golden gzip hex:
1f8b08000000000002ffab564a54b2527adcd8a4a4a394a4646558cb0500dec5bcbb12000000
golden gzip sha256:
04a4d04727b05a82652903adc0359324426c36d845a5804143e007123ef7b065
```

## 4. `run-manifest-v1`

top-level と nested object は closed schema とする。

```json
{
  "schema_version": "run-manifest-v1",
  "run_id": "r0-fixture-20260830",
  "pipeline": "identity-lite",
  "status": "succeeded",
  "as_of": "2026-08-30T00:00:00Z",
  "code": {"repository": "taichiiiiiiii/automatic-paper-search", "commit_sha": "40 lowercase hex", "dirty": false},
  "invocation": {"projector": "identity-lite-v1", "config_input_id": "config", "parameters": {}},
  "dependencies": {"manager": "uv", "lock_path": "uv.lock", "lock_sha256": "64 lowercase hex", "python": "3.12", "environment_sha256": null},
  "inputs": [],
  "artifacts": [],
  "outputs": [],
  "producers": [],
  "counts": {},
  "failures": []
}
```

- `run_id`: `^[a-z0-9][a-z0-9._-]{0,127}$`
- `pipeline`: `^[a-z0-9][a-z0-9._-]{0,63}$`
- `status`: `succeeded | partial | failed`。replay 可能なのは `succeeded` だけ
- `as_of`: timezone 付き RFC 3339、canonical 表記は `Z`
- `commit_sha`: 40 桁 lowercase hex
- `dirty=true` は記録可能だが byte-identical 保証済みとは表示しない
- projector はコード内 registry の名前だけ。manifest から callable/command を解決しない
- `config_input_id` は `role=config` input を一意に参照する
- `counts` は lower snake key と 0 以上の整数
- failure に raw exception、URL、header、response body を入れない

### 4.1 file reference

`inputs`、`artifacts`、`outputs` は次の closed object を共有する。

```json
{
  "id": "catalog",
  "role": "normalized_snapshot",
  "storage": "bundle",
  "path": "catalog.json.gz",
  "media_type": "application/json",
  "compression": "gzip",
  "stored_size_bytes": 123,
  "content_size_bytes": 456,
  "sha256": "64 lowercase hex",
  "expires_at": "2099-01-01T00:00:00Z"
}
```

- ref `id` は manifest 全体で一意
- input storage は `repository | bundle`、artifact は `bundle`、output は `replay-output`
- compression は `none | gzip`。`none` は stored/content size が一致
- input expiry は timestamp/null、artifact は timestamp 必須、output は null
- path は基準 root からの POSIX relative path だけ
- absolute、空、`.`/`..`、backslash、control char、drive prefix、`.git` segment を拒否
- symlink、symlink ancestor、regular file 以外、resolve 後の root escape を拒否
- manifest は最大 1 MiB、file reference は manifest 全体で最大 128 件
- 1 reference の stored byte は最大 64 MiB、content byte は最大 256 MiB
- manifest 全体の stored byte 合計は最大 256 MiB、content byte 合計は最大 512 MiB
- projector parameter と JSON payload の nesting は root から最大 64 container level
- producer / failure は各 128 件、counts は 256 key を上限とする

producer は name/version/provider/model/prompt_version/schema_version を持つ。LLM の場合だけ
provider/model/prompt_version を非空必須にする。

failure は closed object とし、`code`、`stage`、`count`、`detail` を全て必須にする。
`code` / `stage` は lower snake または kebab identifier、`count` は 0 以上の整数、`detail` は
URL・header・改行・raw exception を含まない 512 文字以下の固定分類文とする。

## 5. Secret scan

manifest の保存前・読込後と、`config | request | llm_response` artifact、projector parameter を走査する。

- 拒否 key: authorization、api_key、access/refresh token、client_secret、password、private_key と各 suffix
- 拒否 value: Bearer/Basic、URL userinfo、token/key/signature query、既知 token prefix、PEM private key
- null/空文字、`max_tokens`、`token_count`、論文本文の通常語 token は許可
- error は値を表示せず JSON pointer と stable code だけを返す

`load_config()` の返り値は `config["env"]` に secret を含み得るため snapshot/hash 対象にしない。

## 6. Error taxonomy と検証順序

```text
REPLAY_MANIFEST_INVALID
REPLAY_SECRET_DETECTED
REPLAY_PATH_INVALID
REPLAY_STATUS_NOT_REPLAYABLE
REPLAY_DEPENDENCY_MISMATCH
REPLAY_ARTIFACT_EXPIRED
REPLAY_ARTIFACT_MISSING
REPLAY_ARTIFACT_HASH_MISMATCH
REPLAY_ARTIFACT_SIZE_MISMATCH
REPLAY_OUTPUT_HASH_MISMATCH
REPLAY_NETWORK_DISABLED
```

検証順序は manifest/semantic → secret → status → lock hash → expiry → safe path → missing →
stored size → stored hash → gzip/content size → projector → output hash とする。`now >= expires_at` は expired。
payload が消え hash だけ残る場合は missing。R0 の dependency mismatch は lock 実 byte の hash 不一致とする。

## 7. Network-free fixture replay

最初の registry は `identity-lite-v1` のみとし、既存 `project_catalogs()` を使う。projector は
`dict[PurePosixPath, bytes]` を返し、自身では repository へ書かない。

- socket connect を fail-fast にし、subprocess、`.env`、process secret を読まない
- socket send/bind/listen、`os.system`、spawn/fork/exec と process environment access も projector 実行中は fail-fast にする
- `--output-dir` は存在しないか空
- sibling temp tree へ全件書き、全 hash 一致後だけ atomic rename
- failure 時は output tree を残さない
- repository、bundle、fixture、seen IDs、history、cache を変更しない

POSIX の input/lock 読込は root から各 path segment を `dir_fd` と `O_NOFOLLOW` で固定し、同じ
final file descriptor で regular-file 判定、size、hash、payload 読込を行う。これらの primitive がない
platform は lexical/lstat/resolve 検証へ fail-safe fallback する。output publish は sibling temp tree の
同一 filesystem rename を境界とし、`--output-dir` parent を別 process が rename できる共有 writable
directory では、呼出側が排他的 ownership を保証する。

## 8. 受入テスト

- JSON/gzip golden byte、SHA、挿入順非依存、別 process byte identity
- NaN/Infinity/非 JSON 型/duplicate key/path traversal/symlink/nested secret を拒否
- runtime validator と JSON Schema の両方を通す
- missing/expired/hash/dependency mismatch を独立 stable code で検証
- 全 network primitive を raise にして fixture replay 成功
- 2 回 replay が byte-identical、output mismatch では publish しない
- preflight failure では projector を呼ばず、入力・repository・状態ファイルを変更しない
- arbitrary module/command 指定を拒否し、CLI failure は非ゼロ終了

## 9. R1 / S2 への引き渡し

R0 後に collector へ explicit `as_of/run_id/artifact_dir` を追加し、Stage 0 snapshot、signal 後 top-N 前、
lineage evidence、LLM response を deterministic gzip 化する。Actions retention、candidate allowlist、manifest
promotion はその時点で設計する。payload は Git に commit しない。R2/CAS は監査需要か容量制約が
実測されるまで導入しない。

## 10. 外部副作用

許可する write は repository 内コード/schema/test fixture と test temp directory だけ。
workflow dispatch、artifact upload/download、Pages/Worker/PyPI 公開、通知、secret/設定変更、push/merge、
実 collector/API/LLM 呼び出し、committed catalog/seen/history/cache の再生成は禁止する。
