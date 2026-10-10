/**
 * Secrets from the environment — TS port of
 * `paperpilot/utils/config_loader.py::load_env` (COL-35 of
 * docs/migration/safety-contracts.md).
 *
 * Secrets (API keys, webhook URLs) live ONLY in environment variables —
 * config.yaml never carries them.
 *
 * DOCUMENTED SIMPLIFICATION (per the task's instruction h, narrowed by the
 * P4 review round 2 MEDIUM-2 fix, and the P4 review round 3 LOW fix for the
 * quoted-value case below): Python's `load_dotenv` handles the full `.env`
 * grammar (multi-line values, `$VAR` interpolation, single-quoted keys,
 * etc) via a real tokenizer (`dotenv/parser.py`). This port's
 * `parseDotenv` only covers the subset that grammar's `parse_binding`
 * actually exercises for this repo's `.env` files: `#`-prefixed/blank
 * lines are skipped, an optional `export ` prefix (requires trailing
 * whitespace, like `_export`'s regex) is stripped before the key, an
 * optional single/double-quoted value has its quotes stripped, an
 * UNQUOTED value's trailing `\s+#.*` is stripped as an inline comment
 * (mirrors `parse_unquoted_value`'s `re.sub(r"\s+#.*", "", part)` — a
 * comment needs at least one whitespace character before the `#`;
 * `url=http://x#frag` has no space before its `#` and is NOT treated as a
 * comment), and no interpolation, multi-line values, backslash escapes
 * inside quotes, or quoted keys are supported. A trailing inline comment
 * after a QUOTED value (`KEY="v" # c`) IS stripped, matching upstream's
 * `_comment` regex (`(?:[^\S\r\n]*#[^\r\n]*)?`, applied right after the
 * closing quote regardless of quoting) — unlike the unquoted case, no
 * leading whitespace is required before the `#` here, so `KEY="v"#c` is
 * also a comment (see {@link stripQuoted}).
 *
 * find_dotenv fallback: when `loadConfig` finds no `.env` next to the
 * config file, Python's `load_env(None)` branch calls bare `load_dotenv()`,
 * which calls `find_dotenv()` — an upward directory walk from a start
 * path, stopping at the first `.env` found. Python's default `usecwd=False`
 * resolves that start path via stack-frame introspection (the first
 * non-`dotenv`-module caller frame's file — in practice always
 * `paperpilot/utils/` for this codebase, since that one Python module is
 * the only caller). TS has no frame-based equivalent, so this port's
 * default start dir ({@link defaultDotenvStartDir}) is
 * `<repoRoot>/paperpilot/utils` (`repoRoot` = the directory containing
 * `pnpm-workspace.yaml`, found by walking up from THIS source file) —
 * matching Python's actual caller directory, not a Node CLI's possibly
 * unrelated `process.cwd()` (P4 review round 3 LOW). `loadEnv`'s optional
 * third parameter overrides this start dir so tests don't depend on
 * either the real repo layout on disk or `process.cwd()`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor } from "@paperpilot/core/layout";

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
  /** R2-19: OpenAlex API key (`PAPERPILOT_OPENALEX_API_KEY`, else `OPENALEX_API_KEY`). */
  openalexApiKey?: string | null;
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
// A quoted value's inline comment: ZERO-or-more whitespace characters (not
// one-or-more, unlike the unquoted case above) then `#` then the rest of
// the line — mirrors python-dotenv's `_comment` regex
// (`(?:[^\S\r\n]*#[^\r\n]*)?`), which runs unconditionally right after the
// closing quote. `KEY="v"#c` is therefore a comment even with no space.
const QUOTED_TRAILING_COMMENT_RE = /^\s*#/;

/**
 * If `value` starts with a `"` or `'`, and that quote has a matching close
 * (first occurrence of the same character after position 0 — this port
 * does not support `parse_value`'s backslash-escaped quotes, see module
 * doc), AND whatever follows the closing quote is empty or an inline
 * comment, returns the unquoted inner text. Otherwise returns `null` (not
 * a quoted value this minimal grammar recognizes) so the caller falls
 * back to the unquoted path.
 */
function stripQuoted(value: string): string | null {
  if (value.length < 2) return null;
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return null;
  const closeIdx = value.indexOf(quote, 1);
  if (closeIdx === -1) return null;
  const rest = value.slice(closeIdx + 1);
  if (rest !== "" && !QUOTED_TRAILING_COMMENT_RE.test(rest)) return null;
  return value.slice(1, closeIdx);
}

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
    const quoted = stripQuoted(value);
    if (quoted !== null) {
      value = quoted;
    } else {
      value = value.replace(INLINE_COMMENT_RE, "").trimEnd();
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Walks upward from `startDir` looking for a regular-file `.env` (TS
 * analogue of python-dotenv's `find_dotenv()` upward search — see module
 * doc for the start-path difference). A non-regular-file match — most
 * notably a `.env` DIRECTORY, e.g. one created by `python -m venv .env` in
 * some ancestor of the real start dir — is skipped and the walk continues
 * upward instead of handing a directory path to `readFileSync` (which
 * would throw `EISDIR`); python-dotenv's own `find_dotenv` likewise only
 * ever returns a regular file or FIFO (P4 review round 3 LOW). Returns the
 * first match, or `null` if none exists all the way up to the filesystem
 * root.
 */
export function findDotenvUpward(startDir: string, stopDir?: string): string | null {
  let dir = resolve(startDir);
  const stop = stopDir === undefined ? undefined : resolve(stopDir);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Vanished between existsSync and statSync — nothing to return;
        // keep walking as if it had never existed.
      }
    }
    if (stop !== undefined && dir === stop) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Directory containing `pnpm-workspace.yaml`, found by walking up from
 * `startDir`. Throws if none exists above `startDir` (would mean this
 * source file was moved out of the pnpm workspace, not a runtime
 * condition this port expects to handle gracefully).
 */
function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`pnpm-workspace.yaml not found above ${startDir}`);
    }
    dir = parent;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The default start dir for {@link findDotenvUpward} when `loadEnv` is
 * called with no `.env` next to the config file: the layout's config
 * directory (`data/config/` after the P5 move, where `.env.example`
 * lives). The default search stops at the repository root
 * ({@link defaultDotenvStopDir}) so a `.env` outside the checkout (e.g. in
 * `$HOME`) is never picked up implicitly.
 */
export function defaultDotenvStartDir(): string {
  return layoutFor(findRepoRoot(HERE)).config;
}

/** Upper bound of the default `.env` search: the repository root. */
export function defaultDotenvStopDir(): string {
  return findRepoRoot(HERE);
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
 * `startDir` overrides where that upward search starts (and is only even
 * consulted when `dotenvPath` is `null` — it never runs the
 * `pnpm-workspace.yaml` walk when an explicit path was given). Production
 * callers never pass it (the default, {@link defaultDotenvStartDir}, is
 * what actually matches Python's behavior); it exists purely so tests can
 * exercise the fallback without depending on the real repo layout on disk
 * or on `process.cwd()`.
 */
export function loadEnv(dotenvPath: string | null = null, startDir?: string): Env {
  const fileVars: Record<string, string> = {};
  const resolvedPath =
    dotenvPath ??
    (startDir === undefined
      ? findDotenvUpward(defaultDotenvStartDir(), defaultDotenvStopDir())
      : findDotenvUpward(startDir));
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
    openalexApiKey:
      (get("PAPERPILOT_OPENALEX_API_KEY") ?? "").trim() ||
      (get("OPENALEX_API_KEY") ?? "").trim() ||
      null,
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
