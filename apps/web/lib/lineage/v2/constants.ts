/**
 * Shared constants for the lineage-artifact-v2 / lineage-pilot-index-v1
 * / lineage-audit-fixtures-v2 / lineage-quality-v2 contract -- a 1:1
 * port of the top-of-file constants in docs/assets/lineage-v2-core.js.
 *
 * Keep every value here byte-identical to the JS source. This is the
 * strict "v2" release reader (SCR-44..SCR-48); a looser value here
 * (e.g. a relaxed regex or a bigger size bound) would accept bytes the
 * JS rejects, which is exactly the drift these safety contracts exist
 * to prevent. test/lineage/focus/*.test.ts ports
 * paperpilot/tests/viewer/test_lineage_v2_core.mjs's cases 1:1 against
 * these modules, not the JS.
 */

export const INDEX_VERSION = "lineage-pilot-index-v1" as const;
export const ARTIFACT_VERSION = "lineage-artifact-v2" as const;
export const FIXTURE_VERSION = "lineage-audit-fixtures-v2" as const;
export const QUALITY_VERSION = "lineage-quality-v2" as const;
export const PILOT_PROFILE = "claim-verified-pilot-v1" as const;

export const PAPER_ID_RE = /^[0-9a-f]{40}$/;
export const SHA_RE = /^[0-9a-f]{64}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type Relation =
  | "supersedes"
  | "successor"
  | "extends"
  | "ablation"
  | "baseline_only"
  | "contrasts";

export const GENEALOGY = new Set<Relation>(["supersedes", "successor", "extends"]);
export const COMPARISON = new Set<Relation>(["ablation", "baseline_only", "contrasts"]);
export const RELATIONS = new Set<Relation>([...GENEALOGY, ...COMPARISON]);

export type Decision = "accepted" | "unknown" | "abstained" | "rejected";
export const DECISIONS = new Set<Decision>(["accepted", "unknown", "abstained", "rejected"]);

export type TrustTier = "verified" | "corroborated" | "tentative";
export const TRUST_TIERS = new Set<TrustTier>(["verified", "corroborated", "tentative"]);

export const METHODS = new Set([
  "human_review",
  "llm",
  "citation_heuristic",
  "intent_map",
  "context_pattern",
  "year_cite",
  "title_version",
  "foundational_allowlist",
]);

export type AliasNamespace = "arxiv" | "openreview" | "acl_anthology" | "cvf" | "doi";
export const ALIAS_NAMESPACES = new Set<AliasNamespace>([
  "arxiv",
  "openreview",
  "acl_anthology",
  "cvf",
  "doi",
]);

export type EvidenceSupport = "supports" | "insufficient" | "conflicts";
export const SUPPORT = new Set<EvidenceSupport>(["supports", "insufficient", "conflicts"]);

export type CheckStatus = "unknown" | "passed" | "failed" | "not_applicable";
export const STATUS = new Set<CheckStatus>(["unknown", "passed", "failed", "not_applicable"]);

export const MAX_JSON_DEPTH = 64;
export const MAX_JSON_VALUES = 100_000;
export const MAX_STRING_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;
export const MAX_QUALITY_BYTES = 256 * 1024;
export const MAX_INDEX_BYTES = 256 * 1024;
export const MAX_NODES = 10_000;
export const MAX_LINKS = 50_000;
export const MAX_EVIDENCE = 50_000;
export const MAX_CLAIMS = 50_000;
export const MAX_EXPANDED_IDS = 64;
export const MAX_STATE_TEXT = 8192;
