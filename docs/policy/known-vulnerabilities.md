# Known / accepted dependency vulnerabilities

## sprintf-js <= 1.1.3 — GHSA-hp3w-g68c-fv3c (Dependabot #12, medium)

- Type: DoS via unbounded precision specifiers in `sprintf()` format strings.
- No patched version exists upstream.
- Path: `@paperpilot/pipeline` (optional dep) -> `@huggingface/transformers` ->
  `onnxruntime-node` -> `global-agent` -> `roarr` -> `sprintf-js@1.1.3`.
- Reachability: `roarr` only formats its own log messages with developer-written
  format strings; attacker-controlled precision specifiers never reach it. The
  pipeline runs offline in batch (no network-facing service), and the package is
  not in the web bundle or the Worker API.
- Assessment: not reachable. Recommend dismissing as `tolerable_risk`; revisit
  when upstream publishes a fix or `onnxruntime-node` drops `global-agent`.

## Fixed via `pnpm.overrides` (root package.json)

- `sharp >=0.35.5` (alerts #3, #9, #13) — previously 0.34.5 via `@huggingface/transformers`.
- `postcss >=8.5.23` (alerts #2, #4, #5, #6) — previously 8.4.31 nested in `next`.
  Remove the overrides once next / transformers ship patched ranges.
