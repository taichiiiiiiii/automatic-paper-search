/**
 * Minimal console (+ optional file append) logger — TS port of
 * `paperpilot/utils/logger.py`.
 *
 * INTENTIONAL SIMPLIFICATION (documented, not a safety-contract item — no
 * COL-/OUT- row references this module): Python's version configures a
 * `TimedRotatingFileHandler` (daily rotation, 7-day retention). None of
 * the ported safety contracts depend on log rotation; this module's scope
 * is "somewhere a WARNING/INFO line goes so an operator/test can see it",
 * which every signal/stage/exporter in this port needs via a small
 * `Logger` interface. Rotation can be added later without changing that
 * interface if an operational need for it appears.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface LoggerOptions {
  /** Minimum level written to the console. One of "DEBUG"|"INFO"|"WARNING"|"ERROR". Default "INFO". */
  level?: string;
  /** If set, every line (regardless of console level) is also appended here. */
  file?: string | null;
  now?: () => Date;
}

const LEVELS = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3 } as const;

function formatLine(now: Date, level: string, name: string, msg: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${ts} [${level}] ${name}: ${msg}`;
}

/** Creates a named `Logger`. `setupLogging`'s `level`/`file` apply to every logger from the same call. */
export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const consoleLevel =
    LEVELS[(options.level ?? "INFO").toUpperCase() as keyof typeof LEVELS] ?? LEVELS.INFO;
  const file = options.file ?? null;
  const now = options.now ?? (() => new Date());
  if (file) mkdirSync(dirname(file), { recursive: true });

  const write = (levelName: keyof typeof LEVELS, msg: string) => {
    const line = formatLine(now(), levelName, name, msg);
    if (file) appendFileSync(file, `${line}\n`, "utf-8");
    if (LEVELS[levelName] >= consoleLevel) {
      // Python's console handler is `logging.StreamHandler(sys.stdout)` —
      // EVERY level (including WARNING/ERROR) goes to stdout, not stderr.
      // `collector.py`'s CLI tests assert on captured stdout for warnings
      // the runner logs, so this is mirrored exactly rather than following
      // Node convention (console.error -> stderr) for warn/error.
      console.log(line);
    }
  };

  return {
    debug: (msg) => write("DEBUG", msg),
    info: (msg) => write("INFO", msg),
    warn: (msg) => write("WARNING", msg),
    error: (msg) => write("ERROR", msg),
  };
}

export const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
