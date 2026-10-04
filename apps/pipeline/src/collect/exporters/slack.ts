/**
 * Slack exporter — posts the top-K papers via Incoming Webhook. TS port of
 * `paperpilot/exporters/slack_exporter.py` (OUT-10, OUT-12..14 of
 * docs/migration/safety-contracts.md).
 *
 * No-ops (returns `null`, does not fail the pipeline) when no webhook URL
 * is configured.
 */

import type { FetchLike } from "../http/requestWithRetry.js";
import { requestWithRetry } from "../http/requestWithRetry.js";
import type { Paper } from "../model/paper.js";
import type { Exporter } from "./exporter.js";

const ALLOWED_URL_SCHEMES = ["http://", "https://"];

export interface SlackExporterConfig {
  enabled?: boolean;
  max_items?: number;
}

export interface SlackExporterDeps {
  fetchImpl: FetchLike;
  webhookUrl?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Clock for the message header's date — injected for determinism. */
  today?: () => Date;
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
}

/** Escapes Slack mrkdwn special characters (`&`, `<`, `>`, in that order). */
function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export class SlackExporter implements Exporter {
  readonly name = "slack";
  enabled: boolean;
  lastDelivered: number | null = null;
  readonly maxItems: number;
  private readonly webhookUrl: string | null;
  private readonly deps: SlackExporterDeps;

  constructor(config: SlackExporterConfig = {}, deps: SlackExporterDeps) {
    this.enabled = config.enabled ?? true;
    this.maxItems = config.max_items ?? 10;
    this.webhookUrl = deps.webhookUrl ?? null;
    this.deps = deps;
  }

  async export(papers: readonly Paper[]): Promise<string | null> {
    this.lastDelivered = 0;
    if (!this.webhookUrl) {
      this.deps.logger?.info("slack: webhook URL not configured; skipping");
      return null;
    }
    if (papers.length === 0) {
      this.deps.logger?.info("slack: no papers to send");
      return null;
    }

    const top = papers.slice(0, this.maxItems);
    const text = this.format(top);
    const resp = await requestWithRetry(
      {
        method: "POST",
        url: this.webhookUrl,
        headers: { "Content-Type": "application/json" },
        jsonBody: { text },
      },
      this.deps,
    );
    if (!resp || resp.status >= 300) {
      const status = resp ? String(resp.status) : "None";
      this.deps.logger?.warn(`slack: post failed (status=${status})`);
      throw new Error(`slack post failed (status=${status})`);
    }
    this.lastDelivered = top.length;
    this.deps.logger?.info(`slack: posted ${top.length} papers`);
    return "slack";
  }

  private format(papers: readonly Paper[]): string {
    const today = (this.deps.today ? this.deps.today() : new Date()).toISOString().slice(0, 10);
    const lines = [`*\u{1F4DA} PaperPilot — ${today} (${papers.length}件)*`];
    papers.forEach((p, i) => {
      const rank = i + 1;
      const title = escapeMrkdwn(p.title);
      const venue = p.venue ? ` [${escapeMrkdwn(p.venue)}]` : "";
      const stars = p.githubStars ? ` ⭐${p.githubStars}` : "";
      const cites = p.citationCount ? ` 引用${p.citationCount}` : "";
      let link: string;
      if (ALLOWED_URL_SCHEMES.some((s) => p.url.toLowerCase().startsWith(s))) {
        link = `<${escapeMrkdwn(p.url)}|${title}>`;
      } else {
        this.deps.logger?.warn(
          `slack: paper ${JSON.stringify(p.title)} has a non-http(s) url; omitting link`,
        );
        link = title;
      }
      lines.push(`${rank}. ${link} — score ${p.totalScore.toFixed(1)}${venue}${stars}${cites}`);
    });
    return lines.join("\n");
  }
}
