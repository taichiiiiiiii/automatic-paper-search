/**
 * ajv (draft 2020-12) validator over the repo's `schemas/*.schema.json`
 * files, loaded at runtime from disk (see paths.ts) rather than copied
 * into packages/core. One Ajv instance holds all 23 schemas so that the
 * single cross-file `$ref` in the set (conference-release-state-v1 ->
 * conference-probe-observation-v1, see
 * docs/migration/schema-inventory.md §6) resolves correctly: ajv matches
 * relative refs against each schema's own `$id`, and every schema here
 * declares `$id: "https://paperpilot.local/schemas/<name>.schema.json"`,
 * so adding every schema to one instance makes that resolution automatic.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { getSchemaDir, listSchemaFiles, schemaNameFromFile } from "./paths.js";

export interface ValidationResult {
  ok: boolean;
  errors: ErrorObject[] | null;
}

interface LoadedSchemas {
  ajv: Ajv2020;
  idByName: Map<string, string>;
}

let loaded: LoadedSchemas | undefined;
const compiledByName = new Map<string, ValidateFunction>();

function loadAllSchemas(): LoadedSchemas {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const dir = getSchemaDir();
  const idByName = new Map<string, string>();
  for (const file of listSchemaFiles()) {
    const raw = readFileSync(join(dir, file), "utf8");
    const schema = JSON.parse(raw) as AnySchemaObject;
    const name = schemaNameFromFile(file);
    ajv.addSchema(schema);
    idByName.set(name, typeof schema.$id === "string" ? schema.$id : name);
  }
  return { ajv, idByName };
}

function getLoaded(): LoadedSchemas {
  if (!loaded) loaded = loadAllSchemas();
  return loaded;
}

function normalizeSchemaName(schemaName: string): string {
  const suffix = ".schema.json";
  return schemaName.endsWith(suffix) ? schemaName.slice(0, -suffix.length) : schemaName;
}

function getValidateFunction(schemaName: string): ValidateFunction {
  const name = normalizeSchemaName(schemaName);
  const cached = compiledByName.get(name);
  if (cached) return cached;

  const { ajv, idByName } = getLoaded();
  const id = idByName.get(name);
  if (!id) {
    const known = [...idByName.keys()].sort().join(", ");
    throw new Error(`unknown schema name "${schemaName}". Known schemas: ${known}`);
  }
  const validate = ajv.getSchema(id);
  if (!validate) {
    throw new Error(`ajv failed to resolve a compiled validator for "${schemaName}" (id=${id})`);
  }
  compiledByName.set(name, validate);
  return validate;
}

/**
 * Validates `data` against the named schema (with or without the
 * `.schema.json` suffix, e.g. both "lineage-artifact-v1" and
 * "lineage-artifact-v1.schema.json" work).
 */
export function validateArtifact(schemaName: string, data: unknown): ValidationResult {
  const validate = getValidateFunction(schemaName);
  const ok = Boolean(validate(data));
  return { ok, errors: ok ? null : (validate.errors ?? null) };
}

/** Sorted list of known schema names (without the `.schema.json` suffix). */
export function listSchemaNames(): string[] {
  const { idByName } = getLoaded();
  return [...idByName.keys()].sort();
}
