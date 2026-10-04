/**
 * SMTP transport decision for the real collect CLI entry (#26/#29 of
 * docs/migration/p4-followups.md).
 *
 * DECISION (reported per the task brief, not silently assumed): this port
 * does NOT implement a real SMTP client. The three options considered:
 *
 *   1. `nodemailer` (or any other SMTP package) — forbidden by this
 *      migration's "no new deps" rule.
 *   2. A minimal hand-rolled STARTTLS client over `node:net`/`node:tls`.
 *      Rejected as NOT "small": a faithful client needs the STARTTLS
 *      command, a second EHLO after the TLS upgrade, AUTH LOGIN/PLAIN,
 *      multi-line `250-`/`250 ` response continuation parsing, CRLF
 *      line discipline with dot-stuffing for the DATA phase, and a
 *      `multipart/alternative` MIME body carrying an RFC 2047
 *      encoded-word Subject (the exporter's subject starts with "📚" and
 *      may contain Japanese — see `exporters/email.ts`'s
 *      `buildMessage`/`htmlBody`). Testing the STARTTLS branch (the
 *      actual TLS upgrade, not just the plaintext EHLO/MAIL/RCPT/DATA
 *      dialog) against a fake server also needs a certificate fixture.
 *      None of that is bounded enough to call "small and testable
 *      against a fake server" per the task's own criterion.
 *   3. (chosen) Wire a transport whose `connect()` throws a clear,
 *      distinguishable error.
 *
 * `EmailExporter.export()` (OUT-15) already no-ops BEFORE ever touching
 * this transport when `output.email.smtp.server`/`to` are not configured
 * — see `exporters/email.ts`. So `connect()` here only throws for a run
 * that genuinely asked for email delivery (`output.email.enabled: true`
 * AND `PAPERPILOT_SMTP_SERVER`/`PAPERPILOT_EMAIL_TO` set); both shipped
 * configs (`paperpilot/config.yaml`, `paperpilot/config.daily-watch.yaml`)
 * have `output.email.enabled: false`, so this is a zero-risk default in
 * practice today.
 *
 * `PipelineRunner.run()`'s export loop (collect LOW / OUT-15/16) catches
 * whatever `exp.export(papers)` throws, records `export:email:<message>`
 * in `errors`/run_history, and keeps running every OTHER enabled exporter
 * (Fail-Safe) — so a config that turns email on gets a loud, specific
 * failure (and `--fail-on-errors` correctly exits non-zero, since
 * `export:` is one of the prefixes `failureExitCode` checks) instead of a
 * silent no-op or a crash.
 */

import type { SmtpClientFactory } from "../exporters/email.js";

export const SMTP_UNAVAILABLE_MESSAGE = "SMTP not available in the TS runtime";

/** See module doc for the decision this implements. */
export function createUnavailableEmailTransport(): SmtpClientFactory {
  return {
    connect: async () => {
      throw new Error(SMTP_UNAVAILABLE_MESSAGE);
    },
  };
}
