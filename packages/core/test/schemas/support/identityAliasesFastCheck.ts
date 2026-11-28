/**
 * Test-only fast equivalent of `validateArtifact("identity-aliases-v1", data)`
 * (#570 C). The production validator (src/schemas/validator.ts) is NOT
 * changed: release/promote checks keep running ajv with the real schema.
 *
 * Why: the schema is a top-level `uniqueItems: true` array of 3-tuples.
 * ajv cannot hash array items, so it compares every pair with a deep
 * equal (O(n^2)); at ~55k tuples that one agreement case took 18-39 s.
 *
 * How: (1) validate with a copy of the schema that has only
 * `uniqueItems` removed (own Ajv instance, own `$id`, so it never collides
 * with the shared production instance), and (2) detect duplicates in O(n)
 * with a Set of canonical JSON strings. The canonical form encodes the
 * same equality ajv uses for `uniqueItems` (fast-deep-equal over JSON
 * values): arrays compare element-wise in order, objects compare by key set
 * regardless of key order, scalars compare by type and value (1 != "1").
 * identityAliasesFastCheck.test.ts pins verdict equality with ajv on small
 * synthetic arrays.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnySchemaObject, ValidateFunction } from "ajv/dist/2020.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { getSchemaDir } from "../../../src/schemas/index.js";

/** Canonical JSON string: object keys sorted, everything else as JSON.stringify. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** True when two items of `data` are deep-equal (ajv `uniqueItems` rule), in O(n). */
export function hasDuplicateItems(data: readonly unknown[]): boolean {
  const seen = new Set<string>();
  for (const item of data) {
    const key = canonicalJson(item);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

let compiled: ValidateFunction | undefined;

function validatorWithoutUniqueItems(): ValidateFunction {
  if (compiled) return compiled;
  const schema = JSON.parse(
    readFileSync(join(getSchemaDir(), "identity-aliases-v1.schema.json"), "utf8"),
  ) as AnySchemaObject;
  if (schema.uniqueItems !== true) {
    // The fast check only replaces this one keyword; fail loudly if the
    // schema stops having it (or changes shape) instead of silently
    // checking something else.
    throw new Error("identity-aliases-v1 schema no longer has top-level uniqueItems: true");
  }
  const { uniqueItems: _dropped, ...rest } = schema;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  compiled = ajv.compile({
    ...rest,
    $id: "https://paperpilot.local/test/identity-aliases-v1-no-unique-items.schema.json",
  });
  return compiled;
}

/** Same ok/invalid verdict as `validateArtifact("identity-aliases-v1", data).ok`. */
export function validateIdentityAliasesFast(data: unknown): { ok: boolean; reason: string | null } {
  const validate = validatorWithoutUniqueItems();
  if (!validate(data)) {
    const first = validate.errors?.[0];
    return { ok: false, reason: `${first?.instancePath || "/"} ${first?.message ?? ""}` };
  }
  if (Array.isArray(data) && hasDuplicateItems(data)) {
    return { ok: false, reason: "/ must NOT have duplicate items" };
  }
  return { ok: true, reason: null };
}
