# 26. Docker-first execution contract

- **決定日:** 2026-09-01
- **状態:** phase 1 static contractローカル実装済み（28 passed）。approved image pull/build/runtime、CI shadow gate、workflow移行は未実施
- **対象:** collector、operator tools、test/CI、静的site preview、paper slide worker
- **非対象:** Pagesの配信方式変更、workflow dispatch、image publish、registry/secret設定変更

PaperPilotのproduction実行と統合検証をDockerへ移す方針を正本とする。`uv`は削除せず、`uv.lock`の依存解決・更新と
任意のホスト上高速check、image builder内のlocked installだけに限定する。approved imageのruntimeとCI shadow gateが
通るまでは既存workflowがhost `uv`を使う移行期間であり、ホストの`uv run`成功だけをproduction完了根拠にしない。

## 1. target separation

| target | 責務 | network | writable |
|---|---|---|---|
| `collector` | Stage 0〜4の通常収集 | phase 1はunrestricted outbound | output/data/logsとbounded `/tmp` |
| `ops` | core依存だけで動くsite/search/lineage/replay projector | none | `docs`/`paperpilot/data`/共有outputとbounded `/tmp` |
| `test` | Python contract/lint | runtimeはnone | bounded `/tmp`だけ |
| `node-test` | Worker/viewer contract | none | bounded `/tmp`だけ |
| `site-preview` | `docs/`のローカル目視 | localhost inboundのみ | なし |
| `paper-slide-worker` | untrusted PDF解析 | none | bounded tmpfsだけ |

GitHub Pagesは引き続き検証済み静的artifactを配信する。`site-preview`はlocal/browser QA専用で、本番web serverを
追加するものではない。previewは`docs/`を`/site/automatic-paper-search`へmountし、公開環境と同じ
`http://127.0.0.1:8137/automatic-paper-search/`で検証してabsolute project-base assetを壊さない。

`test`だけはnon-production source-suite例外であり、image-owned checkoutとtest toolingを保持する。Git hook fixtureを
正しく実行するため、このtargetのbounded `/tmp`だけは`exec`を許可する。別途neutral cwdからnon-editable installed
artifactをsmokeする。pure Node suiteはNode baseから作る専用`node-test`で動かし、Python imageへNode binaryを単体copy
しない。

## 2. uv boundary

- `uv.lock`を唯一のPython dependency resolution snapshotとし、clean checkoutに必ず存在させる
- builder/test targetは`uv sync --frozen --no-editable`を使い、runtimeで依存を再解決しない
- collector runtimeにuv、pip、compiler、source checkout、test、fixtureを残さない
- root packageはwheelまたはnon-editable installとしてroot-owned filesystemへ置く
- `pyproject.toml`の範囲指定だけを使う`pip install .`、build中のpip/setuptools/wheel upgradeを禁止する
- host `uv run`はlock checkや一件の高速unit testには使えるが、Docker gateを代替しない

phase 1ではlock/hashを使うnetworked dependency fetchを許可するが、release-readyとは称さない。phase 2でplatform別
wheelhouse/hash manifestを作り、release imageを`--network=none --no-index`で再構築する。

## 3. immutable build inputs

- Dockerfile frontend、Python base、uv image、Node baseは`repository@sha256:<64 lowercase hex>`だけ
- code-owned repositoryは`docker.io/library/python`、`ghcr.io/astral-sh/uv`、`docker.io/library/node`に閉じ、
  tool versionはPython 3.12、uv 0.12.7、Node 20に固定する。Python baseはtest targetのapt contractに合わせて
  `/bin/sh`、`apt-get`、`/etc/debian_version`を持つDebian-compatible imageだけを許可する
- Dockerfileにmutable tagのdefaultを置かない。approved digestはdeployment environmentから必須入力にする
- `.dockerignore`はallowlistとし、`.git`、`.env`、archive、output、logs、secret、不要なgenerated dataをcontextへ送らない
- build contextに必要なtest/schema/docs/workflow artifactはtest target用だけ。collector targetへcopyしない
- base/frontend digest、SBOM、signature/provenance、platformを別release gateで検証する
- `linux/amd64`と`linux/arm64/v8`を別artifactとしてbuild/testし、digestを混同しない
- canonical `docker/paperpilot-compose`がraw Composeより前に、ref形式/repository、local presence、RepoDigest、
  Linux platform、tool versionをnetworkなしで検証する。wrapperはpull/push、alternate file、implicit build、
  volume/privileged/user/entrypoint/network/env-file overrideを拒否する
- wrapperはlocal Docker operatorに対するsandboxではない。daemonを操作できる主体はwrapperを迂回できるため、
  trusted operator/CIのadmission policyとして扱う

## 4. runtime policy

collector/ops/node-testの共通最低条件（`test`のsource-suite例外は上記）:

- numeric non-root `65532:65532`
- read-only root filesystem、`cap_drop: ALL`、`no-new-privileges`
- bounded PID、memory、CPU、`/tmp` tmpfs
- source checkout、host root、Docker socket、device、SSH agentをmountしない
- configはread-only、write先はoutput/data/logsなど明示したvolumeだけ
- collectorにinbound portを公開しない。site previewだけlocalhostへportをbindする
- restartはoperator/workflow側が決め、Compose既定は`no`
- secretをimage、build arg、label、log、fixtureへ入れない。将来は`*_FILE=/run/secrets/...`へ統一する

Docker Compose単体ではhostname単位のegress allowlistを強制できない。phase 1 collectorは外向き通信を制限して
いないため、egress proxy/firewallを実装するまで「source APIだけ」と表現しない。`ops`はnetwork noneとし、
API collection、LLM、Sheets、unarXive download、PDF worker orchestrationを担当範囲に含めない。Linux上で`ops`の
writable bind mountを使う場合、host側`docs`/`paperpilot/data`がnumeric `65532:65532`から書けることを前提にする。
collectorとprojectorの受け渡しには同じ`paperpilot-output` named volumeをread/writeでmountする。これは
`build_summary_csv`/`build_pages`が収集artifactを読み、summary/page artifactを更新するために必要な唯一の追加write先である。
opsのimage-owned sourceからはfinal stage前に`.env*`、output、logs、testsを除去し、mutable stateは明示mountだけから得る。

## 5. PDF worker boundary

専用[`containers/paper-slide-worker/Dockerfile`](../../containers/paper-slide-worker/Dockerfile)をroot imageへ統合しない。
collector containerへDocker socketをmountしてworkerを起動するとhost-root相当になるため禁止する。digest allowlistを持つ
host側trusted executorが、networkなし、read-only、capabilityなし、resource limit付きで一件ずつworkerを起動する。

workerのbase/candidate inspect、wheelhouse、filesystem/SBOM、実image E2Eは通常collectorとは独立したrelease gateとする。
visible-text attestationが完成するまではworker imageが存在してもfull-text slide生成を有効化しない。

## 6. canonical commands

標準入口はwrapperだけとする。digest環境ファイルにはsecretを置かず、shellへexportしてから呼ぶ。

```sh
docker/paperpilot-compose build test node-test
docker/paperpilot-compose run --rm --no-deps test

docker/paperpilot-compose run --rm --no-deps node-test

docker/paperpilot-compose build collector
docker/paperpilot-compose run --rm --no-deps collector \
  --config /etc/paperpilot/config.yaml --skip-llm

docker/paperpilot-compose build ops site-preview
docker/paperpilot-compose run --rm --no-deps ops \
  -m paperpilot.scripts.build_search_index --help
docker/paperpilot-compose --profile preview up --no-build site-preview
```

`.env.docker`はbase image digestなど非秘密のdeployment inputだけを持つ。API key用の既存`paperpilot/.env`とは分離する。
checked-in `docker/docker-env.example`のplaceholderは意図的にinvalidであり、承認済みrefとして扱わない。base/frontend
image取得はwrapper外の別承認操作で、wrapper自身とCompose runtimeは暗黙pullしない。phase 1のuv/apt dependency buildは
networkedかつ非hermeticであり、offline releaseとは呼ばない。

## 7. acceptance gates

- root Docker/Compose/.dockerignoreのstatic contract test
- wrapper fake-Docker testが必須digestなし、tag、uppercase、別registry、local missing、wrong platform/version、
  Docker socket/過剰mount overrideを拒否
- test/node-test runtimeでnetworkなし、skip inventory固定、Ruff/Python/Node suiteを一度ずつ実行
- collectorのpackage import/CLI help、numeric UID、read-only smoke
- site previewのroot/search/catalog/lineage/slide asset smokeと320px/desktop目視
- amd64/arm64の同一fixture artifact hash。platform依存値はmanifestで分離
- production runtime filesystem inventoryにtest、fixture、`.env`、uv/pip/ensurepip/compiler、private key、credential fileがない
- image size、dependency CVE/SBOM、provenance、base digestの承認

image build/pull、CI shadow gate、workflow移行、registry push、deployはそれぞれ別の明示承認を要する。Dockerfileの
static test合格だけを、実image検証済みと表現しない。

## 8. migration order

1. `uv.lock`と現行full gateを固定
2. root multi-stage Dockerfile、Compose policy、allowlist context、contract tests
3. local digest入力でDocker test/Node/site preview smoke
4. 既存uv CIとDocker shadow gateの同値比較
5. tests workflowをDocker一回実行へ移行
6. collector/ops workflowを一本ずつtargetへ移行
7. platform wheelhouseによるoffline release build
8. README/運用文書でhost uvを補助経路へ降格

本契約のphase 1はローカル実装であり、image publish、workflow実行、Pages/Worker deployを行わない。
