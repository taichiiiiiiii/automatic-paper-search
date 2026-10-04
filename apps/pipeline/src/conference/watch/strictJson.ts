/**
 * Strict JSON parsing that rejects duplicate object keys — TS port of
 * `paperpilot/replay/canonical.py::strict_json_loads`'s duplicate-key half
 * (CNF-35 of docs/migration/safety-contracts.md).
 *
 * JS's native `JSON.parse` silently keeps the LAST value for a duplicate
 * key (`{"a":1,"a":2}` -> `{a:2}`) and has no reviver hook that can
 * observe the collision — the reviver only sees the already-deduped
 * object. There is no library-free way to detect this without a custom
 * parser, so this module is one: a small recursive-descent JSON parser
 * that behaves exactly like `JSON.parse` except it throws
 * `DuplicateKeyError` on a repeated object key.
 *
 * Non-finite numbers (`NaN`/`Infinity`/`-Infinity`) need no special
 * handling here: those are a CPython `json` extension Python's own
 * `parse_constant` hook exists to reject — standard JSON (and this
 * parser) has no such tokens in its grammar at all, so a body containing
 * them is already a plain syntax error, matching the strict spec both
 * sides are bound by.
 */

export class StrictJsonSyntaxError extends Error {}
export class DuplicateKeyError extends Error {}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

class Scanner {
  private pos = 0;
  constructor(private readonly text: string) {}

  private skipWhitespace(): void {
    while (this.pos < this.text.length && WHITESPACE.has(this.text[this.pos] as string)) this.pos++;
  }

  private peek(): string {
    if (this.pos >= this.text.length) throw new StrictJsonSyntaxError("unexpected end of input");
    return this.text[this.pos] as string;
  }

  private expect(ch: string): void {
    if (this.peek() !== ch)
      throw new StrictJsonSyntaxError(`expected '${ch}' at position ${this.pos}`);
    this.pos++;
  }

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.pos !== this.text.length)
      throw new StrictJsonSyntaxError("trailing data after JSON value");
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (ch === '"') return this.parseString();
    if (ch === "t") return this.parseLiteral("true", true);
    if (ch === "f") return this.parseLiteral("false", false);
    if (ch === "n") return this.parseLiteral("null", null);
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.parseNumber();
    throw new StrictJsonSyntaxError(`unexpected character '${ch}' at position ${this.pos}`);
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (this.text.slice(this.pos, this.pos + literal.length) !== literal) {
      throw new StrictJsonSyntaxError(`invalid literal at position ${this.pos}`);
    }
    this.pos += literal.length;
    return value;
  }

  private parseObject(): Record<string, unknown> {
    this.expect("{");
    const result: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.pos++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.parseString();
      this.skipWhitespace();
      this.expect(":");
      const value = this.parseValue();
      if (Object.hasOwn(result, key)) {
        throw new DuplicateKeyError(`duplicate object key: ${JSON.stringify(key)}`);
      }
      result[key] = value;
      this.skipWhitespace();
      const next = this.peek();
      if (next === ",") {
        this.pos++;
        continue;
      }
      if (next === "}") {
        this.pos++;
        return result;
      }
      throw new StrictJsonSyntaxError(`expected ',' or '}' at position ${this.pos}`);
    }
  }

  private parseArray(): unknown[] {
    this.expect("[");
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.pos++;
      return result;
    }
    for (;;) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const next = this.peek();
      if (next === ",") {
        this.pos++;
        continue;
      }
      if (next === "]") {
        this.pos++;
        return result;
      }
      throw new StrictJsonSyntaxError(`expected ',' or ']' at position ${this.pos}`);
    }
  }

  private parseString(): string {
    this.expect('"');
    let out = "";
    for (;;) {
      const ch = this.peek();
      this.pos++;
      if (ch === '"') return out;
      if (ch === "\\") {
        const esc = this.peek();
        this.pos++;
        switch (esc) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = this.text.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex))
              throw new StrictJsonSyntaxError("invalid \\u escape");
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            throw new StrictJsonSyntaxError(`invalid escape '\\${esc}'`);
        }
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) throw new StrictJsonSyntaxError("unescaped control character in string");
      out += ch;
    }
  }

  private charAt(index: number): string {
    return index < this.text.length ? this.text.charAt(index) : "";
  }

  private parseNumber(): number {
    const start = this.pos;
    if (this.charAt(this.pos) === "-") this.pos++;
    while (this.charAt(this.pos) >= "0" && this.charAt(this.pos) <= "9") this.pos++;
    if (this.charAt(this.pos) === ".") {
      this.pos++;
      while (this.charAt(this.pos) >= "0" && this.charAt(this.pos) <= "9") this.pos++;
    }
    if (this.charAt(this.pos) === "e" || this.charAt(this.pos) === "E") {
      this.pos++;
      if (this.charAt(this.pos) === "+" || this.charAt(this.pos) === "-") this.pos++;
      while (this.charAt(this.pos) >= "0" && this.charAt(this.pos) <= "9") this.pos++;
    }
    const raw = this.text.slice(start, this.pos);
    if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) {
      throw new StrictJsonSyntaxError(`invalid number literal: ${raw}`);
    }
    return Number(raw);
  }
}

/** Parse JSON text, throwing {@link DuplicateKeyError} on a repeated object key (depth is bounded only by the call stack — callers with an untrusted-depth concern should bound input size first, as `dryRun.ts` does via its byte-size checks before calling this). */
export function strictJsonLoads(text: string): unknown {
  return new Scanner(text).parse();
}
