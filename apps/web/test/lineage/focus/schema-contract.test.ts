/**
 * Cross-checks the exact-key lists the v2 readers enforce at runtime
 * (`lib/lineage/v2/pilot-index.ts` `ENTRY_KEYS`,
 * `lib/lineage/v2/artifact.ts`'s exported `*_KEYS`) against
 * `schemas/lineage-pilot-index-v1.schema.json` and
 * `schemas/lineage-artifact-v2.schema.json`'s `required`/`properties`
 * sets. These schemas are the producer-side (Python) documentation of
 * the same contract; a silent drift here would mean the schema no
 * longer describes what this reader actually accepts (or the reverse
 * -- the reader silently loosened past what the schema promises).
 * This is the "contracts as Vitest" port the page-port brief asks for.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_KEYS,
  CANDIDATE_UNIVERSE_KEYS,
  CLAIM_KEYS,
  CLASSIFICATION_KEYS,
  ENTRY_KEYS,
  EVIDENCE_KEYS,
  LINK_KEYS,
  LOCATOR_KEYS,
  META_KEYS,
  NODE_KEYS,
  PRODUCER_KEYS,
  REVIEW_BINDING_KEYS,
} from "../../../lib/lineage/v2";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../../..");

interface JsonSchema {
  required?: string[];
  properties?: Record<string, unknown>;
  $defs?: Record<string, JsonSchema>;
}

function readSchema(relativePath: string): JsonSchema {
  return JSON.parse(readFileSync(resolve(repository, relativePath), "utf8"));
}

/** A schema's `required` list IS its exact-key set here: every one of
 * these schemas also sets `additionalProperties: false` and lists
 * every property as required (checked below too), so `required` and
 * `Object.keys(properties)` must already agree with each other before
 * either is compared against the reader's own list. */
function expectExactKeyParity(
  schema: JsonSchema,
  expected: readonly string[],
  label: string,
): void {
  expect(schema.properties, `${label}: schema must declare properties`).toBeDefined();
  const propertyKeys = Object.keys(schema.properties ?? {}).sort();
  const requiredKeys = [...(schema.required ?? [])].sort();
  expect(requiredKeys, `${label}: required must list every property (and only those)`).toEqual(
    propertyKeys,
  );
  expect([...expected].sort(), `${label}: reader's exact-key list must match the schema`).toEqual(
    propertyKeys,
  );
}

describe("lineage-pilot-index-v1 schema parity", () => {
  const schema = readSchema("schemas/lineage-pilot-index-v1.schema.json");

  it("top-level entry keys match ENTRY_KEYS", () => {
    const entry = schema.$defs?.entry as JsonSchema;
    expectExactKeyParity(entry, ENTRY_KEYS, "pilot-index entry");
  });
});

describe("lineage-artifact-v2 schema parity", () => {
  const schema = readSchema("schemas/lineage-artifact-v2.schema.json");

  it("top-level artifact keys match ARTIFACT_KEYS", () => {
    expectExactKeyParity(schema, ARTIFACT_KEYS, "artifact");
  });

  it("node keys match NODE_KEYS", () => {
    expectExactKeyParity(schema.$defs?.node as JsonSchema, NODE_KEYS, "node");
  });

  it("link keys match LINK_KEYS", () => {
    expectExactKeyParity(schema.$defs?.link as JsonSchema, LINK_KEYS, "link");
  });

  it("locator keys match LOCATOR_KEYS", () => {
    expectExactKeyParity(schema.$defs?.locator as JsonSchema, LOCATOR_KEYS, "locator");
  });

  it("evidence keys match EVIDENCE_KEYS", () => {
    expectExactKeyParity(schema.$defs?.evidence as JsonSchema, EVIDENCE_KEYS, "evidence");
  });

  it("classification keys match CLASSIFICATION_KEYS", () => {
    expectExactKeyParity(
      schema.$defs?.classification as JsonSchema,
      CLASSIFICATION_KEYS,
      "classification",
    );
  });

  it("review binding keys match REVIEW_BINDING_KEYS", () => {
    expectExactKeyParity(
      schema.$defs?.reviewBinding as JsonSchema,
      REVIEW_BINDING_KEYS,
      "reviewBinding",
    );
  });

  it("claim keys match CLAIM_KEYS", () => {
    expectExactKeyParity(schema.$defs?.claim as JsonSchema, CLAIM_KEYS, "claim");
  });

  it("meta keys match META_KEYS, and its nested objects match PRODUCER_KEYS/CANDIDATE_UNIVERSE_KEYS", () => {
    const meta = schema.$defs?.meta as JsonSchema;
    expectExactKeyParity(meta, META_KEYS, "meta");
    const producer = (meta.properties?.producer ?? {}) as JsonSchema;
    expectExactKeyParity(producer, PRODUCER_KEYS, "meta.producer");
    const candidateUniverse = (meta.properties?.candidate_universe ?? {}) as JsonSchema;
    expectExactKeyParity(candidateUniverse, CANDIDATE_UNIVERSE_KEYS, "meta.candidate_universe");
  });
});
