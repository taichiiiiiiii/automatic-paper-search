import { readFile } from "node:fs/promises";
import { matchGlob } from "./glob.js";
import { parsePointer } from "./json-pointer.js";
import type { IgnoreRule, RulesFile } from "./types.js";

export interface MatchedIgnore {
  glob: string;
  pointers: string[];
}

export async function loadRules(filePath: string | undefined): Promise<RulesFile> {
  if (!filePath) return {};
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse rules file ${filePath}: ${(err as Error).message}`);
  }
  validateRulesFile(parsed, filePath);
  return parsed as RulesFile;
}

function validateRulesFile(parsed: unknown, filePath: string): asserts parsed is RulesFile {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid rules file ${filePath}: expected a JSON object with an "ignore" array`,
    );
  }
  const ignore = (parsed as { ignore?: unknown }).ignore;
  if (ignore === undefined) return;
  if (!Array.isArray(ignore)) {
    throw new Error(`Invalid rules file ${filePath}: "ignore" must be an array`);
  }
  for (const [i, rule] of ignore.entries()) {
    if (
      rule === null ||
      typeof rule !== "object" ||
      typeof (rule as IgnoreRule).glob !== "string" ||
      !Array.isArray((rule as IgnoreRule).pointers) ||
      !(rule as IgnoreRule).pointers.every((p) => typeof p === "string")
    ) {
      throw new Error(
        `Invalid rules file ${filePath}: ignore[${i}] must be { "glob": string, "pointers": string[] }`,
      );
    }
  }
}

/** Every ignore rule whose glob matches `relPath`, in file order. */
export function rulesForFile(rules: RulesFile, relPath: string): MatchedIgnore[] {
  const matched: MatchedIgnore[] = [];
  for (const rule of rules.ignore ?? []) {
    if (matchGlob(rule.glob, relPath)) {
      matched.push({ glob: rule.glob, pointers: rule.pointers });
    }
  }
  return matched;
}

/** Flattens matched ignore rules into parsed JSON-pointer segment lists, for json-diff. */
export function toIgnoreSegments(matched: readonly MatchedIgnore[]): string[][] {
  return matched.flatMap((m) => m.pointers.map(parsePointer));
}
