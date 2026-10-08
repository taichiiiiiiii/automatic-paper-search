// Worker environment bindings for apps/api. Supersedes worker/index.ts's
// `Env` interface (adds the KV flags binding, the Durable Object binding,
// and the explicit DISPATCH_MODE var — see docs/design/39 §4.2-7, §4.5).

import type { FlagsKv } from "./lib/kv-flags.js";

export interface Env {
  // GitHub fine-grained PAT, `actions:write`. Empty/unset in dry-run mode.
  GH_DISPATCH_PAT?: string;
  GH_OWNER: string;
  GH_REPO: string;
  GH_WORKFLOW_FILE: string;
  GH_REF: string;
  // §4.5: explicit mode binding — never inferred from PAT presence.
  DISPATCH_MODE?: string;
  // §4.2-6/7: origin allowlist + accept-stop flag, read fresh per request.
  // KVNamespace in production; any object satisfying FlagsKv in tests.
  // GET /api/health reads KV_KEY_NAMESPACE_TAG from this binding (not a
  // `vars` default — see src/config.ts) so a misbound namespace shows up
  // as a wrong/missing tag instead of a reassuring but false one.
  CONFIG_KV: FlagsKv;
  // Durable Object binding for exact quota counting (§5). Optional in the
  // Env type because tests supply a quota backend directly via deps and
  // never touch this field.
  QUOTA?: DurableObjectNamespace;
}
