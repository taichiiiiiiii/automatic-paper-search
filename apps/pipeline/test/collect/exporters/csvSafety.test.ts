/**
 * Port of `paperpilot/tests/test_csv_safety.py`.
 */
import { describe, expect, it } from "vitest";
import {
  FORMULA_TRIGGERS,
  neutralize,
  neutralizeRow,
  unneutralize,
} from "../../../src/collect/exporters/csvSafety.js";

const SAMPLES = [
  "-Deep nets",
  '=SUM(1,2),"http://evil"',
  "+44 7700 900000",
  "@SUM(1)",
  "\ttabbed title",
  "\rCR title",
  "Attention Is All You Need",
  "https://arxiv.org/abs/2404.00001",
  "2026-04-18",
  "",
  "'Deep nets revisited",
];

describe("test_unneutralize_inverts_neutralize", () => {
  it.each(SAMPLES)("round-trips %s", (value) => {
    expect(unneutralize(neutralize(value))).toBe(value);
  });
});

describe("test_every_trigger_is_prefixed_and_removed", () => {
  it.each(FORMULA_TRIGGERS)("trigger %j", (trigger) => {
    const value = `${trigger}cell`;
    expect(neutralize(value)).toBe(`'${value}`);
    expect(unneutralize(`'${value}`)).toBe(value);
  });
});

it("test_neutralize_leaves_ordinary_cells_exactly_as_read", () => {
  for (const value of [
    "Attention Is All You Need",
    "https://arxiv.org/abs/2404.00001",
    "",
    "2026",
  ]) {
    expect(neutralize(value)).toBe(value);
  }
});

it("test_a_genuine_leading_apostrophe_survives_both_steps", () => {
  const title = "'Deep nets";
  expect(neutralize(title)).toBe(title);
  expect(unneutralize(title)).toBe(title);
});

it("test_only_one_prefix_is_removed", () => {
  expect(unneutralize("''=SUM(1)")).toBe("''=SUM(1)");
  expect(unneutralize(neutralize(neutralize("=x")))).toBe("=x");
});

it("test_an_apostrophe_anywhere_else_is_untouched", () => {
  expect(unneutralize("Don't - stop")).toBe("Don't - stop");
  expect(unneutralize("'")).toBe("'");
  expect(unneutralize("")).toBe("");
});

it("test_a_quote_followed_by_a_trigger_is_read_as_a_guard_prefix", () => {
  expect(unneutralize("'=SUM(1)")).toBe("=SUM(1)");
});

it("test_neutralize_row_leaves_non_string_cells_alone", () => {
  const row = { title: "-Deep nets", citation_count: 3, missing: null };
  expect(neutralizeRow(row)).toEqual({
    title: "'-Deep nets",
    citation_count: 3,
    missing: null,
  });
});
