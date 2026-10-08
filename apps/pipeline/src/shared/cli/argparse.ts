/**
 * Shared strict CLI flag parser (M3 of the P4 review) — a TS analogue of
 * the subset of Python's `argparse` every ported script's original
 * parser actually used: long `--flag` options only (no short aliases, no
 * positionals besides each CLI's own hand-rolled subcommand/positional
 * dispatch, which stays outside this parser), `store_true`, `type=int`,
 * `type=float`, `action="append"`, `choices`, and `required`.
 *
 * Behaviour this intentionally mirrors (so a flag typo or a bad value
 * fails loudly instead of being silently ignored or mis-parsed):
 *  - An unrecognized flag, a missing required flag, a missing value, or
 *    an unparseable int/float all throw {@link CliUsageError} — the
 *    caller maps that to `argparse`'s `exit(2)` + usage-on-stderr
 *    contract (see {@link parseOrExit}).
 *  - `--flag=value` and `--flag value` are both accepted.
 *  - Unique-prefix abbreviation, like argparse's `allow_abbrev=True`
 *    default: `--fail-on-error` resolves to `--fail-on-errors` when it
 *    is the only flag starting with that prefix; an exact match always
 *    wins over a prefix match; an ambiguous prefix is a hard error.
 *  - A `store_true` flag rejects an explicit `=value`
 *    (`--clear-oral=false` is an error, not a silently-true `true`) —
 *    this is argparse's actual behaviour for a zero-arg action, not an
 *    invented stricter rule.
 *  - A value token that itself looks like another option (starts with
 *    `-` and is not a bare negative number) is treated as a missing
 *    value, matching argparse's own look-ahead.
 */

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export type FlagSpec =
  | { type: "string"; required?: boolean; default?: string; choices?: readonly string[] }
  | { type: "int"; required?: boolean; default?: number }
  | { type: "float"; required?: boolean; default?: number }
  | { type: "boolean" }
  | { type: "repeated-string"; default?: string[] };

export type ParsedFlag = string | number | boolean | string[] | undefined;

const NEGATIVE_NUMBER_RE = /^-\d+(\.\d+)?$/;
const INT_RE = /^[+-]?\d+$/;
// Python float(): optional sign, digits with an optional decimal point
// (either side may be empty, e.g. ".5" or "5."), optional exponent.
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

function looksLikeOptionToken(token: string | undefined): boolean {
  if (token === undefined || token === "-") return false;
  return token.startsWith("-") && !NEGATIVE_NUMBER_RE.test(token);
}

/** Exact match wins; otherwise a unique prefix match; otherwise throws. */
function resolveFlagName(rawName: string, spec: Readonly<Record<string, FlagSpec>>): string {
  if (rawName in spec) return rawName;
  const candidates = Object.keys(spec).filter(
    (name) => name.startsWith(rawName) && rawName.length > 0,
  );
  if (candidates.length === 1) return candidates[0] as string;
  if (candidates.length > 1) {
    throw new CliUsageError(
      `ambiguous option: --${rawName} could match ${candidates.map((c) => `--${c}`).join(", ")}`,
    );
  }
  throw new CliUsageError(`unrecognized arguments: --${rawName}`);
}

function parseIntStrict(raw: string, name: string): number {
  const trimmed = raw.trim();
  if (!INT_RE.test(trimmed)) {
    throw new CliUsageError(`argument --${name}: invalid int value: ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(trimmed, 10);
}

function parseFloatStrict(raw: string, name: string): number {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  if (
    lowered === "inf" ||
    lowered === "+inf" ||
    lowered === "infinity" ||
    lowered === "+infinity"
  ) {
    return Number.POSITIVE_INFINITY;
  }
  if (lowered === "-inf" || lowered === "-infinity") return Number.NEGATIVE_INFINITY;
  if (lowered === "nan" || lowered === "+nan" || lowered === "-nan") return Number.NaN;
  if (!FLOAT_RE.test(trimmed)) {
    throw new CliUsageError(`argument --${name}: invalid float value: ${JSON.stringify(raw)}`);
  }
  return Number.parseFloat(trimmed);
}

/**
 * Parses `--flag value` / `--flag=value` / `--boolean-flag` tokens per
 * `spec`. Throws {@link CliUsageError} on an unknown/ambiguous flag, a
 * positional token, a missing value for a non-boolean flag, an
 * unparseable int/float, a `store_true` flag given `=value`, a value not
 * in `choices`, or a missing required flag. Pure — never touches
 * `process.exit`/stderr (see {@link parseOrExit} for that).
 */
export function parseArgs(
  argv: readonly string[],
  spec: Readonly<Record<string, FlagSpec>>,
): Record<string, ParsedFlag> {
  const out: Record<string, ParsedFlag> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) {
      throw new CliUsageError(`unrecognized arguments: ${JSON.stringify(token)}`);
    }
    const eq = token.indexOf("=");
    const rawName = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
    const name = resolveFlagName(rawName, spec);
    const field = spec[name] as FlagSpec;

    if (field.type === "boolean") {
      if (inlineValue !== undefined) {
        throw new CliUsageError(
          `argument --${name}: ignored explicit argument ${JSON.stringify(inlineValue)}`,
        );
      }
      out[name] = true;
      continue;
    }

    let raw = inlineValue;
    if (raw === undefined) {
      const next = argv[i + 1];
      if (next === undefined || looksLikeOptionToken(next)) {
        throw new CliUsageError(`argument --${name}: expected one argument`);
      }
      raw = next;
      i++;
    }

    if (field.type === "repeated-string") {
      const existing = (out[name] as string[] | undefined) ?? [];
      existing.push(raw);
      out[name] = existing;
    } else if (field.type === "int") {
      out[name] = parseIntStrict(raw, name);
    } else if (field.type === "float") {
      out[name] = parseFloatStrict(raw, name);
    } else {
      if (field.choices && !field.choices.includes(raw)) {
        throw new CliUsageError(
          `argument --${name}: invalid choice: ${JSON.stringify(raw)} (choose from ${field.choices
            .map((c) => JSON.stringify(c))
            .join(", ")})`,
        );
      }
      out[name] = raw;
    }
  }

  for (const [name, field] of Object.entries(spec)) {
    if (out[name] !== undefined) continue;
    if (field.type === "boolean") {
      out[name] = false;
    } else if (field.type === "repeated-string") {
      out[name] = field.default ?? [];
    } else if ("default" in field && field.default !== undefined) {
      out[name] = field.default;
    } else if ("required" in field && field.required) {
      throw new CliUsageError(`the following arguments are required: --${name}`);
    }
  }

  return out;
}

export interface ParseOrExitIo {
  stderr: (line: string) => void;
  exit: (code: number) => never;
}

function defaultIo(): ParseOrExitIo {
  return {
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    exit: (code) => process.exit(code),
  };
}

/**
 * {@link parseArgs}, but maps a {@link CliUsageError} to argparse's own
 * contract: the message on stderr, then `exit(2)`. `io` is injectable so
 * tests can assert on the message/code without actually calling
 * `process.exit`.
 */
export function parseOrExit(
  argv: readonly string[],
  spec: Readonly<Record<string, FlagSpec>>,
  prog: string,
  io: ParseOrExitIo = defaultIo(),
): Record<string, ParsedFlag> {
  try {
    return parseArgs(argv, spec);
  } catch (e) {
    if (e instanceof CliUsageError) {
      io.stderr(`${prog}: error: ${e.message}`);
      return io.exit(2);
    }
    throw e;
  }
}
