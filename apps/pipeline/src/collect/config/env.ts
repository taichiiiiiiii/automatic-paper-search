/**
 * Secrets from the environment — TS port of
 * `paperpilot/utils/config_loader.py::load_env` (COL-35 of
 * docs/migration/safety-contracts.md).
 *
 * Secrets (API keys, webhook URLs) live ONLY in environment variables —
 * config.yaml never carries them.
 *
 * DOCUMENTED SIMPLIFICATION (per the task's instruction h, narrowed by the
 * P4 review round 2 MEDIUM-2 fix): Python's `load_dotenv` handles the full
 * `.env` grammar (multi-line values, `$VAR` interpolation, single-quoted
 * keys, etc) via a real tokenizer (`dotenv/parser.py`). This port's
 * `parseDotenv` only covers the subset that grammar's `parse_binding`
 * actually exercises for this repo's `.env` files: `#`-prefixed/blank
 * lines are skipped, an optional `export ` prefix (requires trailing
 * whitespace, like `_export`'s regex) is stripped before the key, an
 * optional single/double-quoted value has its quotes stripped, an
 * UNQUOTED value's trailing `\s+#.*` is stripped as an inline comment
 * (mirrors `parse_unquoted_value`'s `re.sub(r"\s+#.*", "", part)` — a
 * comment needs at least one whitespace character before the `#`;
 * `url=http://x#frag` has no space before its `#` and is NOT treated as a
 * comment), and no interpolation, multi-line values, or quoted keys are
 * supported. A trailing inline comment after a QUOTED value (`KEY="v" #
 * c`) is also not specially handled — a narrower gap than upstream's,
 * intentionally left, since no `.env` in this repo quotes a value and
 * then comments it.
 *
 * find_dotenv fallback: when `loadConfig` finds no `.env` next to the
 * config file, Python's `load_env(None)` branch calls bare `load_dotenv()`,
 * which calls `find_dotenv()` — an upward directory walk from a start
 * path, stopping at the first `.env` found. Python's default `usecwd=False`
 * resolves that start path via stack-frame introspection (the first
 * non-`dotenv`-module caller frame's file — in practice always
 * `paperpilot/utils/` for this codebase, since that one Python module is
 * the only caller). TS has no frame-based equivalent, so this port starts
 * the walk at `process.cwd()` instead (`findDotenvUpward`) — the same
 * directory `usecwd=True` would use, and the closest practical analogue
 * for a Node CLI invoked from a project directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

// `export KEY=...` — the `export` keyword requires at least one trailing
// whitespace character before the key starts (mirrors python-dotenv's
// `_export = r"(?:export[^\S\r\n]+)?"`), so a key that merely STARTS WITH
// the letters "export" (e.g. `exported_flag=1`) is not mistaken for the
// prefix.
const EXPORT_PREFIX_RE = /^export\s+/;
// An unquoted value's inline comment: one-or-more whitespace characters
// then `#` then the rest of the line (mirrors python-dotenv's
// `parse_unquoted_value`'s `re.sub(r"\s+#.*", "", part)`). No leading
// whitespace before the `#` means it is part of the value, not a comment.
const INLINE_COMMENT_RE = /\s+#.*$/s;

/** Parses a minimal `KEY=VALUE` `.env` file into a plain map (see module doc for scope). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(EXPORT_PREFIX_RE, "");
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(INLINE_COMMENT_RE, "").trimEnd();
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Walks upward from `startDir` looking for a `.env` file (TS analogue of
 * python-dotenv's `find_dotenv()` upward search — see module doc for the
 * start-path difference). Returns the first match, or `null` if none
 * exists all the way up to the filesystem root.
 */
export function findDotenvUpward(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `process.env` wins over a `.env` file value for the same key — mirrors
 * `load_dotenv`'s default `override=False`: dotenv only fills keys NOT
 * already present in the environment (even an empty-string env value
 * counts as "already present" and is kept), it never overwrites one that
 * is.
 */
function getenv(vars: Record<string, string>, key: string): string | null {
  const envValue = process.env[key];
  if (envValue !== undefined) return envValue;
  const fileValue = vars[key];
  return fileValue === undefined ? null : fileValue;
}

/**
 * Loads `.env` merged under `process.env` (process env wins — matches
 * `load_dotenv`'s default `override=False`, see {@link getenv}), and
 * returns the secrets dict. When `dotenvPath` is given (and exists — the
 * only way `loadConfig` ever calls this with a non-null path), that exact
 * file is used, matching Python's `load_dotenv(dotenv_path)` branch. When
 * `dotenvPath` is `null` (no `.env` next to the config file), falls back
 * to the upward search {@link findDotenvUpward} does, matching Python's
 * bare `load_dotenv()` -> `find_dotenv()` branch (see module doc).
 */
export function loadEnv(dotenvPath: string | null = null): Env {
  const fileVars: Record<string, string> = {};
  const resolvedPath = dotenvPath ?? findDotenvUpward(process.cwd());
  if (resolvedPath && existsSync(resolvedPath)) {
    Object.assign(fileVars, parseDotenv(readFileSync(resolvedPath, "utf-8")));
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
