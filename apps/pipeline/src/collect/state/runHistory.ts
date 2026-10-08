/**
 * Run history — appends one JSON line per run. TS port of
 * `paperpilot/pipeline/runner.py::PipelineRunner._append_history` (COL-32
 * of docs/migration/safety-contracts.md).
 *
 * Every run appends exactly one line including `finished_at` /
 * `sources_status` / `errors` / `degraded_signals` / `truncated_deliveries`
 * / `truncated_windows`. A workflow can point at its own file via
 * `incremental.run_history_file` (daily-watch and weekly must not share
 * one, see COL-32's note on L-7).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SourceStatus } from "../stages/collect.js";

export interface RunHistoryRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  stageCounts: Record<string, number>;
  sourcesStatus: Record<string, SourceStatus>;
  errors: string[];
  outputFiles: string[];
  degradedSignals: string[];
  truncatedDeliveries: { exporter: string; delivered: number; given: number }[];
  truncatedWindows: Record<string, string[]>;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `YYYYMMDD_HHMMSS` from local time — mirrors Python's `started.strftime("%Y%m%d_%H%M%S")`. */
export function runId(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function appendRunHistory(path: string, record: RunHistoryRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = `${JSON.stringify({
    run_id: record.runId,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    duration_seconds: record.durationSeconds,
    stage_counts: record.stageCounts,
    sources_status: record.sourcesStatus,
    errors: record.errors,
    output_files: record.outputFiles,
    degraded_signals: record.degradedSignals,
    truncated_deliveries: record.truncatedDeliveries,
    truncated_windows: record.truncatedWindows,
  })}\n`;
  appendFileSync(path, line, "utf-8");
}
