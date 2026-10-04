/**
 * Minimal strict CLI flag parser shared by the openreview/cvf collectors —
 * TS analogue of Python's `argparse` for exactly the contract CNF-01's
 * "no --allow-partial escape hatch" test depends on: an unrecognized flag
 * must be a hard failure (argparse: `SystemExit(2)`; here: throws
 * {@link CliUsageError}) BEFORE any output is written, not a silently
 * ignored extra argument.
 */

export class CliUsageError extends Error {}

export type FlagSpec =
  | { type: "string"; required?: boolean; default?: string }
  | { type: "int"; required?: boolean; default?: number }
  | { type: "float"; required?: boolean; default?: number }
  | { type: "boolean" }
  | { type: "repeated-string" };

export type ParsedFlag = string | number | boolean | string[] | undefined;

/**
 * Parses `--flag value` / `--flag=value` / `--boolean-flag` tokens per
 * `spec`. Throws {@link CliUsageError} on an unknown flag, a missing value
 * for a non-boolean flag, an unparseable int/float, or a missing required
 * flag.
 */
export function parseCliArgs(
  argv: readonly string[],
  spec: Readonly<Record<string, FlagSpec>>,
): Record<string, ParsedFlag> {
  const out: Record<string, ParsedFlag> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) {
      throw new CliUsageError(`unexpected positional argument: ${JSON.stringify(token)}`);
    }
    const eq = token.indexOf("=");
    const name = (eq >= 0 ? token.slice(2, eq) : token.slice(2)) as string;
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
    const field = spec[name];
    if (!field) {
      throw new CliUsageError(`unrecognized arguments: ${token}`);
    }
    if (field.type === "boolean") {
      out[name] = true;
      continue;
    }
    let raw = inlineValue;
    if (raw === undefined) {
      const next = argv[i + 1];
      if (next === undefined) {
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
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n) || !/^-?\d+$/.test(raw)) {
        throw new CliUsageError(`argument --${name}: invalid int value: ${JSON.stringify(raw)}`);
      }
      out[name] = n;
    } else if (field.type === "float") {
      const n = Number.parseFloat(raw);
      if (Number.isNaN(n)) {
        throw new CliUsageError(`argument --${name}: invalid float value: ${JSON.stringify(raw)}`);
      }
      out[name] = n;
    } else {
      out[name] = raw;
    }
  }

  for (const [name, field] of Object.entries(spec)) {
    if (out[name] !== undefined) continue;
    if (field.type === "boolean") {
      out[name] = false;
    } else if ("default" in field && field.default !== undefined) {
      out[name] = field.default;
    } else if ("required" in field && field.required) {
      throw new CliUsageError(`the following arguments are required: --${name}`);
    }
  }

  return out;
}
