/**
 * Secrets from the environment — TS port of
 * `paperpilot/utils/config_loader.py::load_env` (COL-35 of
 * docs/migration/safety-contracts.md).
 *
 * Secrets (API keys, webhook URLs) live ONLY in environment variables —
 * config.yaml never carries them.
 *
 * INTENTIONAL SIMPLIFICATION (documented, per the task's instruction h):
 * Python's `load_dotenv` does a cwd-upward search and handles the full
 * `.env` grammar (export prefix, multi-line values, `$VAR` interpolation,
 * etc). This port only needs the exact-path case (`loadConfig` always
 * passes a concrete `.env` path sitting next to the config file, never
 * relies on an upward search), so `parseDotenv` here is a minimal
 * `KEY=VALUE` line parser: `#`-prefixed/blank lines are skipped, an
 * optional single/double-quoted value has its quotes stripped, and no
 * interpolation or multi-line values are supported. Every case the ported
 * tests (`test_config_loader`'s `.env`-next-to-config fixture) exercise is
 * covered.
 */

import { existsSync, readFileSync } from "node:fs";

export interface SmtpEnv {
  server: string | null;
  port: number;
  user: string | null;
  password: string | null;
  to: string | null;
  useTls: boolean;
}

export interface Env {
  githubToken: string | null;
  s2ApiKey: string | null;
  openalexEmail: string | null;
  slackWebhookUrl: string | null;
  geminiApiKey: string | null;
  claudeApiKey: string | null;
  groqApiKey: string | null;
  groqModel: string | null;
  geminiModel: string | null;
  smtp: SmtpEnv;
}

/** Parses a minimal `KEY=VALUE` `.env` file into a plain map (see module doc for scope). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function getenv(vars: Record<string, string>, key: string): string | null {
  const value = vars[key] ?? process.env[key];
  return value === undefined ? null : value;
}

/**
 * Loads `.env` (if `dotenvPath` is given and exists) merged under
 * `process.env` (process env wins — matches `load_dotenv`'s default
 * `override=False` only in effect, since we read `.env` values as the
 * fallback, not an override), and returns the secrets dict.
 */
export function loadEnv(dotenvPath: string | null = null): Env {
  const fileVars: Record<string, string> = {};
  if (dotenvPath && existsSync(dotenvPath)) {
    Object.assign(fileVars, parseDotenv(readFileSync(dotenvPath, "utf-8")));
  }
  const get = (key: string) => getenv(fileVars, key);

  const portRaw = get("PAPERPILOT_SMTP_PORT");
  let smtpPort = 587;
  if (portRaw) {
    const parsed = Number.parseInt(portRaw, 10);
    if (!Number.isNaN(parsed)) smtpPort = parsed;
  }

  return {
    githubToken: get("PAPERPILOT_GITHUB_TOKEN"),
    s2ApiKey: get("PAPERPILOT_S2_API_KEY"),
    openalexEmail: get("PAPERPILOT_OPENALEX_EMAIL"),
    slackWebhookUrl: get("PAPERPILOT_SLACK_WEBHOOK_URL"),
    geminiApiKey: get("PAPERPILOT_GEMINI_API_KEY"),
    claudeApiKey: get("PAPERPILOT_CLAUDE_API_KEY"),
    groqApiKey: get("PAPERPILOT_GROQ_API_KEY"),
    groqModel: get("PAPERPILOT_GROQ_MODEL"),
    geminiModel: get("PAPERPILOT_GEMINI_MODEL"),
    smtp: {
      server: get("PAPERPILOT_SMTP_SERVER"),
      port: smtpPort,
      user: get("PAPERPILOT_SMTP_USER"),
      password: get("PAPERPILOT_SMTP_PASSWORD"),
      to: get("PAPERPILOT_EMAIL_TO"),
      useTls: (get("PAPERPILOT_SMTP_USE_TLS") ?? "true").toLowerCase() !== "false",
    },
  };
}
