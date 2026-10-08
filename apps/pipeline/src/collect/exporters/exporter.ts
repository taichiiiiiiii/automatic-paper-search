/**
 * Exporter plugin contract — TS port of `paperpilot/exporters/base.py`
 * (OUT-09, OUT-12 of docs/migration/safety-contracts.md).
 */

import type { Paper } from "../model/paper.js";

export interface Exporter {
  readonly name: string;
  enabled: boolean;
  /**
   * Papers the most recent `export()` call actually handed to the user, or
   * `null` when the exporter always consumes the whole list. Notification
   * exporters (Slack/Email) cap at `maxItems`, so they set this and the
   * runner can warn about a truncated delivery without duplicating that
   * slicing itself.
   */
  lastDelivered: number | null;
  /**
   * Persists papers. Returns the output path/name, or `null` for a no-op
   * (disabled, unconfigured, or nothing to export — never a failure). A
   * real failure (network error, non-2xx response, SMTP error, etc) MUST
   * be thrown, not swallowed into a `null` return.
   */
  export(papers: readonly Paper[]): Promise<string | null>;
}
