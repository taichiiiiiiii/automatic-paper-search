/**
 * JSON exporter — full paper records as a list. TS port of
 * `paperpilot/exporters/json_exporter.py` (OUT-04..06 of
 * docs/migration/safety-contracts.md).
 *
 * JSON output is compared STRUCTURALLY, not byte-for-byte (§7.2 — key
 * order and float-format differences are tolerated, values are not), so
 * this uses plain `JSON.stringify`/`paperToDict` rather than a
 * Python-`json.dumps`-exact serializer.
 */

import { mkdirSync } from "node:fs";
import type { Paper } from "../model/paper.js";
import { paperToDict } from "../model/paper.js";
import { atomicWriteText } from "../state/atomic.js";
import type { Exporter } from "./exporter.js";
import { resolveExportPath } from "./exportPath.js";

export interface JsonExporterConfig {
  enabled?: boolean;
  dir?: string;
}

export class JSONExporter implements Exporter {
  readonly name = "json";
  enabled: boolean;
  lastDelivered: number | null = null;
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(config: JsonExporterConfig = {}, deps: { now?: () => Date } = {}) {
    this.enabled = config.enabled ?? true;
    this.dir = config.dir ?? "./output";
    this.now = deps.now ?? (() => new Date());
  }

  async export(papers: readonly Paper[]): Promise<string | null> {
    if (papers.length === 0) return null;

    mkdirSync(this.dir, { recursive: true });
    const path = resolveExportPath(this.dir, "json", this.now());

    const payload = papers.map((p) => paperToDict(p));
    // Serialise fully before touching the destination, then replace by
    // rename: writing straight to the destination would truncate it
    // before the first byte, so a failure mid-dump leaves an empty or
    // half-written file for whatever reads it next in the same run.
    const text = JSON.stringify(payload, null, 2);
    atomicWriteText(path, text);
    return path;
  }
}
