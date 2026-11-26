/**
 * #570 C: the identity-aliases agreement case used to run the production
 * validator over the whole published file, where ajv's `uniqueItems` on
 * array items is a pairwise deep-equal (O(n^2), ~18-39 s for ~55k tuples).
 * The agreement suite now checks that file with a fast equivalent
 * (`./support/identityAliasesFastCheck.ts`: the schema minus `uniqueItems`
 * plus an O(n) duplicate check under the same equality rule).
 *
 * This file pins that equivalence: on small synthetic arrays the fast
 * check must reach the same verdict as ajv WITH `uniqueItems` (the
 * production schema via `validateArtifact`), and on the full published
 * file it must agree with the frozen Python verdict (ajv is deliberately
 * not run on the full file here: that would bring the 30 s back).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { layoutFor } from "../../src/layout/index.js";
import { getRepoRoot, validateArtifact } from "../../src/schemas/index.js";
import {
  hasDuplicateItems,
  validateIdentityAliasesFast,
} from "./support/identityAliasesFastCheck.js";

const SCHEMA = "identity-aliases-v1";
const NAMESPACES = ["arxiv", "openreview", "acl_anthology", "cvf", "conference_site", "doi"];

/** Deterministic 40-hex digest for row `i` (satisfies the third prefixItem). */
function hex40(i: number): string {
  return i.toString(16).padStart(40, "0");
}

/** `n` distinct, schema-valid tuples. */
function syntheticRows(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => [
    NAMESPACES[i % NAMESPACES.length],
    `id-${i}`,
    hex40(i),
  ]);
}

/** ajv verdict for the uniqueness keyword alone (no item constraints). */
const uniqueOnly = new Ajv2020({ allErrors: true, strict: false }).compile({ uniqueItems: true });

function expectSameVerdictAsAjv(data: unknown, expectedOk: boolean): void {
  const ajv = validateArtifact(SCHEMA, data);
  const fast = validateIdentityAliasesFast(data);
  expect(ajv.ok).toBe(expectedOk);
  expect(fast.ok).toBe(ajv.ok);
}

describe("identity-aliases fast check (#570 C)", () => {
  it("(a) agrees with the frozen Python verdict on the published file", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "python-verdicts.json"),
        "utf8",
      ),
    ) as { cases: Array<{ schema: string; ok: boolean }> };
    const pyCase = fixture.cases.find((c) => c.schema === SCHEMA);
    expect(pyCase).toBeDefined();
    const data = JSON.parse(
      readFileSync(join(layoutFor(getRepoRoot()).published, "identity-aliases-v1.json"), "utf8"),
    );
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(1000);
    expect(validateIdentityAliasesFast(data).ok).toBe(pyCase?.ok);
  });

  it("(b) rejects an array where exactly one tuple is duplicated, like ajv", () => {
    const rows = syntheticRows(200);
    expectSameVerdictAsAjv(rows, true);
    const dup = [...rows.slice(0, 120), structuredClone(rows[37]), ...rows.slice(120)];
    expectSameVerdictAsAjv(dup, false);
    expect(hasDuplicateItems(dup)).toBe(true);
    // Duplicate at the very ends of the array too.
    const ends = [...rows, structuredClone(rows[0])];
    expectSameVerdictAsAjv(ends, false);
  });

  it("(c) treats tuples that differ only in element order as distinct, like ajv", () => {
    const h = hex40(0xabc);
    const rows = [...syntheticRows(50), ["arxiv", "openreview", h], ["openreview", "arxiv", h]];
    expectSameVerdictAsAjv(rows, true);
    expect(hasDuplicateItems(rows)).toBe(false);
  });

  it("(d) applies ajv's deep-equal rule to mixed-type items", () => {
    const cases: Array<{ data: unknown[]; duplicate: boolean }> = [
      { data: [1, "1"], duplicate: false },
      {
        data: [
          ["arxiv", "1", hex40(1)],
          ["arxiv", 1, hex40(1)],
        ],
        duplicate: false,
      },
      { data: [null, "null"], duplicate: false },
      { data: [true, "true", 1], duplicate: false },
      {
        data: [
          [1, 2],
          [2, 1],
        ],
        duplicate: false,
      },
      { data: [[], {}], duplicate: false },
      {
        data: [
          { a: 1, b: [2, 3] },
          { b: [2, 3], a: 1 },
        ],
        duplicate: true,
      },
      { data: [{ a: 1 }, { a: 1, b: 2 }], duplicate: false },
      { data: [null, null], duplicate: true },
      { data: [["x"], ["x"]], duplicate: true },
      { data: ["a\u0000b", "a", "b"], duplicate: false },
      // JSON.parse output: -0 equals 0, escaped and literal characters are the same string,
      // nested objects compare regardless of key order.
      { data: JSON.parse("[0, -0]"), duplicate: true },
      { data: JSON.parse('["\\u00e9", "\u00e9"]'), duplicate: true },
      { data: [[{ a: 1, b: 2 }], [{ b: 2, a: 1 }]], duplicate: true },
      {
        data: [
          [{ a: 1 }, { b: 2 }],
          [{ b: 2 }, { a: 1 }],
        ],
        duplicate: false,
      },
    ];
    for (const { data, duplicate } of cases) {
      expect(uniqueOnly(data), JSON.stringify(data)).toBe(!duplicate);
      expect(hasDuplicateItems(data), JSON.stringify(data)).toBe(duplicate);
      // Full schema: a wrong-typed item fails either way; the verdicts must still match.
      const mixed = [...syntheticRows(30), ...data];
      expect(validateIdentityAliasesFast(mixed).ok, JSON.stringify(data)).toBe(
        validateArtifact(SCHEMA, mixed).ok,
      );
    }
    // A wrong-typed tuple among unique, otherwise-valid rows: invalid for both.
    expectSameVerdictAsAjv([...syntheticRows(30), ["arxiv", "x", 42]], false);
    expectSameVerdictAsAjv([...syntheticRows(30), ["nope", "x", hex40(9)]], false);
    expectSameVerdictAsAjv({ not: "an array" }, false);
  });
});
