/**
 * Email exporter — delivers the top-K papers via SMTP. TS port of
 * `paperpilot/exporters/email_exporter.py` (OUT-11, OUT-12, OUT-15, OUT-16
 * of docs/migration/safety-contracts.md).
 *
 * Per the task brief, SMTP itself is NOT reimplemented here (no
 * `nodemailer`, no raw SMTP protocol client): the exporter is written
 * against an injected {@link SmtpClientFactory} transport interface whose
 * shape mirrors Python's `smtplib.SMTP` call sequence
 * (connect -> starttls -> login -> sendMessage -> quit) closely enough
 * that a test double can simulate a failure at each step exactly the way
 * the Python tests mock `smtplib.SMTP`.
 *
 * No-ops (`null`) when SMTP server/to are not configured.
 */

import type { Paper } from "../model/paper.js";
import { toLocalIsoDate } from "../pyish.js";
import type { Exporter } from "./exporter.js";

const ALLOWED_URL_SCHEMES = ["http://", "https://"];
const DEFAULT_PORT = 587;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface EmailMessageParts {
  subject: string;
  to: string;
  from: string;
  text: string;
  html: string;
}

/** Mirrors the subset of `smtplib.SMTP`'s call sequence this exporter uses. */
export interface SmtpClient {
  starttls(): Promise<void>;
  login(user: string, password: string): Promise<void>;
  sendMessage(message: EmailMessageParts): Promise<void>;
  quit(): Promise<void>;
}

export interface SmtpClientFactory {
  /** Mirrors `smtplib.SMTP(server, port, timeout=...)` — connection happens here. */
  connect(server: string, port: number, timeoutMs: number): Promise<SmtpClient>;
}

export interface EmailSmtpSettings {
  server?: string | null;
  port?: number | null;
  user?: string | null;
  password?: string | null;
  to?: string | null;
  use_tls?: boolean;
}

export interface EmailExporterConfig {
  enabled?: boolean;
  max_items?: number;
}

export interface EmailExporterDeps {
  smtp?: EmailSmtpSettings;
  transport: SmtpClientFactory;
  /** Clock for the subject/sender fallback date — injected for determinism. */
  today?: () => Date;
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
}

function htmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

export class EmailExporter implements Exporter {
  readonly name = "email";
  enabled: boolean;
  lastDelivered: number | null = null;
  readonly maxItems: number;
  private readonly smtp: EmailSmtpSettings;
  private readonly deps: EmailExporterDeps;

  constructor(config: EmailExporterConfig = {}, deps: EmailExporterDeps) {
    this.enabled = config.enabled ?? true;
    this.maxItems = config.max_items ?? 10;
    this.smtp = deps.smtp ?? {};
    this.deps = deps;
  }

  async export(papers: readonly Paper[]): Promise<string | null> {
    this.lastDelivered = 0;
    if (papers.length === 0) {
      this.deps.logger?.info("email: no papers to send");
      return null;
    }

    const server = this.smtp.server;
    const toAddr = this.smtp.to;
    if (!server || !toAddr) {
      this.deps.logger?.info("email: SMTP server/to not configured; skipping");
      return null;
    }

    const top = papers.slice(0, this.maxItems);
    // Python: `date.today().isoformat()` — LOCAL calendar date (collect
    // LOW: "today" UTC vs local, same bug class as citation.ts/slack.ts).
    const today = toLocalIsoDate(this.deps.today ? this.deps.today() : new Date());
    const message = this.buildMessage(top, toAddr, today);

    let client: SmtpClient;
    try {
      client = await this.deps.transport.connect(
        server,
        this.smtp.port ?? DEFAULT_PORT,
        DEFAULT_TIMEOUT_MS,
      );
    } catch (e) {
      this.deps.logger?.warn(`email: connect failed: ${(e as Error).message}`);
      throw e;
    }

    try {
      if (this.smtp.use_tls ?? true) await client.starttls();
      const user = this.smtp.user;
      const password = this.smtp.password;
      if (user && password) await client.login(user, password);
      await client.sendMessage(message);
    } catch (e) {
      this.deps.logger?.warn(`email: send failed: ${(e as Error).message}`);
      throw e;
    } finally {
      try {
        await client.quit();
      } catch {
        // best-effort cleanup
      }
    }

    this.lastDelivered = top.length;
    this.deps.logger?.info(`email: sent ${top.length} papers to ${toAddr}`);
    return "email";
  }

  private buildMessage(papers: readonly Paper[], toAddr: string, today: string): EmailMessageParts {
    const sender = this.smtp.user || `paperpilot@${today}`;
    return {
      subject: `\u{1F4DA} PaperPilot — ${today} (${papers.length} papers)`,
      to: toAddr,
      from: sender,
      text: EmailExporter.textBody(papers, today),
      html: EmailExporter.htmlBody(papers, today),
    };
  }

  static textBody(papers: readonly Paper[], today: string): string {
    const lines = [`PaperPilot — ${today}`, ""];
    papers.forEach((p, i) => {
      const bits = [`${i + 1}. ${p.title}`, `   score: ${p.totalScore.toFixed(1)}`];
      if (p.venue) bits.push(`   venue: ${p.venue}`);
      if (p.githubStars) bits.push(`   stars: ${p.githubStars}`);
      bits.push(`   url: ${p.url}`);
      if (p.llmSummaryJa) bits.push(`   要約: ${p.llmSummaryJa}`);
      lines.push(...bits, "");
    });
    return lines.join("\n");
  }

  static htmlBody(papers: readonly Paper[], today: string): string {
    const rows = papers.map((p, i) => {
      const venue = p.venue ? htmlEscape(p.venue) : "";
      const summary = p.llmSummaryJa ? htmlEscape(p.llmSummaryJa) : "";
      const title = htmlEscape(p.title);
      let titleCell: string;
      if (ALLOWED_URL_SCHEMES.some((s) => p.url.toLowerCase().startsWith(s))) {
        titleCell = `<a href='${htmlEscape(p.url)}'>${title}</a>`;
      } else {
        titleCell = title;
      }
      return (
        `<tr><td>${i + 1}</td><td>${titleCell}</td><td>${p.totalScore.toFixed(1)}</td>` +
        `<td>${venue}</td><td>${p.githubStars}</td><td>${summary}</td></tr>`
      );
    });
    return (
      `<html><body><h2>\u{1F4DA} PaperPilot — ${today}</h2>` +
      `<table border='1' cellpadding='4'>` +
      `<tr><th>#</th><th>Title</th><th>Score</th><th>Venue</th><th>Stars</th><th>Summary</th></tr>` +
      `${rows.join("")}</table></body></html>`
    );
  }
}
