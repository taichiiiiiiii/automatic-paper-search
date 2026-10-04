/**
 * M3 of the P4 review: the shared strict CLI flag parser, modelled on
 * Python's `argparse` for the subset every ported script's original
 * parser used — unknown flag / missing value / bad int-float / ambiguous
 * prefix all exit non-zero (here: throw {@link CliUsageError}) instead of
 * silently parsing wrong or being ignored.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CliUsageError,
  type FlagSpec,
  parseArgs,
  parseOrExit,
} from "../../../src/shared/cli/argparse.js";

describe("parseArgs", () => {
  const SPEC: Readonly<Record<string, FlagSpec>> = {
    "fail-on-errors": { type: "boolean" },
    days: { type: "int" },
    delay: { type: "float", default: 0.25 },
    conference: { type: "string", required: true },
    keyword: { type: "repeated-string" },
    strict: { type: "string", choices: ["off", "ambiguous", "all"], default: "off" },
  };

  it("parses a boolean store_true flag", () => {
    expect(parseArgs(["--fail-on-errors", "--conference", "x"], SPEC)["fail-on-errors"]).toBe(true);
  });

  it("defaults a boolean flag to false when absent", () => {
    expect(parseArgs(["--conference", "x"], SPEC)["fail-on-errors"]).toBe(false);
  });

  it("parses --flag=value", () => {
    expect(parseArgs(["--conference=cvpr-2026"], SPEC).conference).toBe("cvpr-2026");
  });

  it("parses --flag value", () => {
    expect(parseArgs(["--conference", "cvpr-2026"], SPEC).conference).toBe("cvpr-2026");
  });

  it("resolves a unique prefix abbreviation (allow_abbrev default True)", () => {
    // --fail-on-error is a prefix of --fail-on-errors and no other flag.
    expect(parseArgs(["--fail-on-error", "--conference", "x"], SPEC)["fail-on-errors"]).toBe(true);
  });

  it("an exact match wins over a would-be prefix of a longer flag", () => {
    const spec: Readonly<Record<string, FlagSpec>> = {
      day: { type: "string" },
      days: { type: "string" },
    };
    expect(parseArgs(["--day", "x"], spec).day).toBe("x");
    expect(parseArgs(["--day", "x"], spec).days).toBeUndefined();
  });

  it("throws on an ambiguous prefix matching more than one flag", () => {
    const spec: Readonly<Record<string, FlagSpec>> = {
      "allow-shrink": { type: "boolean" },
      "allow-shrink-for": { type: "repeated-string" },
    };
    expect(() => parseArgs(["--allow-shr"], spec)).toThrow(CliUsageError);
    expect(() => parseArgs(["--allow-shr"], spec)).toThrow(/ambiguous/i);
  });

  it("throws exit-worthy CliUsageError on an unrecognized flag", () => {
    expect(() => parseArgs(["--bogus"], SPEC)).toThrow(CliUsageError);
  });

  it("throws on a bad int value (--days x)", () => {
    expect(() => parseArgs(["--days", "x", "--conference", "y"], SPEC)).toThrow(CliUsageError);
  });

  it("accepts a well-formed int, including a leading +", () => {
    expect(parseArgs(["--days", "+3", "--conference", "y"], SPEC).days).toBe(3);
  });

  it("rejects a float-looking string for an int flag ('5.0')", () => {
    expect(() => parseArgs(["--days", "5.0", "--conference", "y"], SPEC)).toThrow(CliUsageError);
  });

  it("throws on a bad float value", () => {
    expect(() => parseArgs(["--delay", "x", "--conference", "y"], SPEC)).toThrow(CliUsageError);
  });

  it("parses a well-formed float and keeps the default when absent", () => {
    expect(parseArgs(["--delay", "1.5", "--conference", "y"], SPEC).delay).toBe(1.5);
    expect(parseArgs(["--conference", "y"], SPEC).delay).toBe(0.25);
  });

  it("accumulates a repeated-string (append) flag across repeats", () => {
    const out = parseArgs(["--conference", "x", "--keyword", "a", "--keyword", "b"], SPEC).keyword;
    expect(out).toEqual(["a", "b"]);
  });

  it("defaults an absent repeated-string flag to []", () => {
    expect(parseArgs(["--conference", "x"], SPEC).keyword).toEqual([]);
  });

  it("throws when a required flag is missing", () => {
    expect(() => parseArgs([], SPEC)).toThrow(CliUsageError);
    expect(() => parseArgs([], SPEC)).toThrow(/required/);
  });

  it("rejects an explicit =value on a store_true flag (the --clear-oral=false bug)", () => {
    const spec: Readonly<Record<string, FlagSpec>> = { "clear-oral": { type: "boolean" } };
    expect(() => parseArgs(["--clear-oral=false"], spec)).toThrow(CliUsageError);
    // Must NOT silently become true — the historical bug this ports a fix for.
    expect(() => parseArgs(["--clear-oral=false"], spec)).toThrow(/ignored explicit argument/);
  });

  it("rejects a choices value outside the allowed set", () => {
    expect(() => parseArgs(["--conference", "x", "--strict", "bogus"], SPEC)).toThrow(
      CliUsageError,
    );
  });

  it("accepts a value in choices and defaults otherwise", () => {
    expect(parseArgs(["--conference", "x", "--strict", "all"], SPEC).strict).toBe("all");
    expect(parseArgs(["--conference", "x"], SPEC).strict).toBe("off");
  });

  it("treats a missing value followed by another flag as 'expected one argument'", () => {
    expect(() => parseArgs(["--days", "--conference", "y"], SPEC)).toThrow(/expected one argument/);
  });

  it("treats a missing value at the end of argv as 'expected one argument'", () => {
    expect(() => parseArgs(["--conference", "y", "--days"], SPEC)).toThrow(/expected one argument/);
  });

  it("accepts a negative number as a value, not as 'another flag'", () => {
    const spec: Readonly<Record<string, FlagSpec>> = { n: { type: "int" } };
    expect(parseArgs(["--n", "-5"], spec).n).toBe(-5);
  });

  it("rejects a bare positional token", () => {
    expect(() => parseArgs(["bogus", "--conference", "x"], SPEC)).toThrow(CliUsageError);
  });
});

describe("parseOrExit", () => {
  it("returns the parsed result on success without touching stderr/exit", () => {
    const stderr = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;
    const result = parseOrExit(["--x", "1"], { x: { type: "int" } }, "prog", { stderr, exit });
    expect(result.x).toBe(1);
    expect(stderr).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("writes to stderr and exits 2 on a CliUsageError", () => {
    const stderr = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;
    parseOrExit(["--bogus"], { x: { type: "int" } }, "prog", { stderr, exit });
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderr.mock.calls[0]?.[0]).toMatch(/prog: error:/);
  });
});
