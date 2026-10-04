/**
 * Shape of the loaded pipeline config (`config.yaml` / `config.daily-watch.yaml`
 * + injected `env`). Every field is optional, mirroring the Python side's
 * `dict.get(key, default)` access pattern — nothing here is required by the
 * YAML files themselves; the runner supplies the same defaults the Python
 * `PipelineRunner`/stages do, at the point each value is read.
 */
import type { Env } from "./env.js";

export interface SearchConfig {
  keywords?: string[];
  categories?: string[];
  days_back?: number;
  max_results_per_keyword?: number;
  exclude_words?: string[];
}

export interface SourceEntryConfig {
  enabled?: boolean;
  delay_seconds?: number;
}

export interface SourcesConfig {
  arxiv?: SourceEntryConfig;
  s2?: SourceEntryConfig;
  openalex?: SourceEntryConfig;
}

export interface SignalEntryConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface SignalsConfig {
  venue?: SignalEntryConfig;
  citation?: SignalEntryConfig;
  author?: SignalEntryConfig;
  github?: SignalEntryConfig;
  follow?: SignalEntryConfig;
  keyword?: SignalEntryConfig;
}

export interface WeightsConfig {
  venue?: number;
  github?: number;
  citation?: number;
  author?: number;
  keyword?: number;
  follow?: number;
  embedding?: number;
}

export interface PipelineControlConfig {
  stage2_top_n?: number;
  stage3_top_n?: number;
  stage4_top_n?: number;
  require_follow_match?: boolean;
}

export interface ExporterEntryConfig {
  enabled?: boolean;
  dir?: string;
  encoding?: "utf-8" | "utf-8-sig";
  max_items?: number;
}

export interface OutputConfig {
  csv?: ExporterEntryConfig;
  json?: ExporterEntryConfig;
  slack?: ExporterEntryConfig;
  email?: ExporterEntryConfig;
}

export interface IncrementalConfig {
  enabled?: boolean;
  seen_ids_file?: string;
  run_history_file?: string;
  max_age_days?: number;
}

export interface LoggingConfig {
  level?: string;
  file?: string;
}

export interface ProfileConfig {
  description?: string;
  keywords?: string[];
  follow_authors?: string[];
  follow_orgs?: string[];
}

export interface LlmConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
  batch_size?: number;
  [key: string]: unknown;
}

export interface EmbeddingConfig {
  enabled?: boolean;
  backend?: string;
  model?: string;
}

export interface Config {
  search?: SearchConfig;
  sources?: SourcesConfig;
  signals?: SignalsConfig;
  weights?: WeightsConfig;
  pipeline?: PipelineControlConfig;
  embedding?: EmbeddingConfig;
  llm?: LlmConfig;
  profile?: ProfileConfig;
  output?: OutputConfig;
  incremental?: IncrementalConfig;
  logging?: LoggingConfig;
  env: Env;
  [key: string]: unknown;
}
