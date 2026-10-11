/**
 * Human audit drafts for theme lineages (design doc 41 D5, R2-8).
 *
 *   draft  --theme <slug> [--theme …] --out-dir <dir>
 *          Writes `<slug>.audit-pending.json` (verdicts null) and
 *          `<slug>.audit.md` (Japanese sheet) per theme.
 *          `--dblp-cache` (default `data/state/lineage-cache/dblp_venues.json`,
 *          ignored when absent) marks venues that came from DBLP (R2-28).
 *   suggest --draft <file.audit-pending.json> --from <suggestions.json>
 *          Copies a second reviewer's preliminary calls into the draft's
 *          `suggestion` fields (never the verdicts) and re-renders the sheet.
 *          Exit 1 when the file names nodes/relations the draft lacks.
 *   render --draft <file.audit-pending.json>
 *          Re-renders the Markdown sheet next to an edited draft.
 *   import --draft <file.audit-pending.json> [--fixtures <path>] [--write]
 *          Turns an edited draft into a `lineage-audit-fixtures-v1` entry
 *          and dry-runs it through the quality builder. Prints the entry;
 *          `--write` merges it into the fixtures file (the auditor's act).
 *
 * Common flags: `--docs-root` (published tree), `--policy`.
 * Exit codes: 0 ok, 1 draft not importable, 2 usage error.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditFixtures, layoutFor, lineageCacheDir, qualityPolicy } from "@paperpilot/core/layout";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import {
  type AuditDraft,
  AuditImportError,
  applySuggestions,
  buildAuditDraft,
  type DblpVenueCacheEntry,
  importAuditDraft,
  mergeFixtureEntry,
  renderAuditSheet,
  type SuggestionsFile,
} from "./auditDraft.js";
import {
  buildManifest,
  DEFAULT_STRONG_RELATIONS,
  type QualityPolicy,
} from "./buildLineageQuality.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  now: () => Date;
}

const defaultIo: CliIo = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  now: () => new Date(),
};

function strongRelations(policyPath: string): string[] {
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as QualityPolicy;
  return Array.isArray(policy.strong_relations)
    ? policy.strong_relations.filter((r): r is string => typeof r === "string")
    : [...DEFAULT_STRONG_RELATIONS];
}

function sheetPathFor(draftPath: string): string {
  return `${draftPath.replace(/\.audit-pending\.json$/, "")}.audit.md`;
}

function slugOf(collectionId: string): string {
  return collectionId.replace(/^theme:/, "");
}

export function runAuditDraftCli(
  argv: readonly string[],
  repoRoot: string = DEFAULT_REPO_ROOT,
  io: CliIo = defaultIo,
): number {
  const [command, ...rest] = argv;
  const layout = layoutFor(repoRoot);
  let parsed: Record<string, unknown>;
  try {
    if (command === "draft") {
      parsed = parseFlags(rest, {
        theme: { type: "repeated-string" },
        "out-dir": { type: "string", required: true },
        "docs-root": { type: "string", default: layout.published },
        policy: { type: "string", default: qualityPolicy(layout) },
        "dblp-cache": {
          type: "string",
          default: join(lineageCacheDir(layout), "dblp_venues.json"),
        },
      });
      if ((parsed.theme as string[] | undefined)?.length === 0 || !parsed.theme) {
        throw new CliUsageError("draft: at least one --theme is required");
      }
    } else if (command === "render") {
      parsed = parseFlags(rest, { draft: { type: "string", required: true } });
    } else if (command === "suggest") {
      parsed = parseFlags(rest, {
        draft: { type: "string", required: true },
        from: { type: "string", required: true },
      });
    } else if (command === "import") {
      parsed = parseFlags(rest, {
        draft: { type: "string", required: true },
        "docs-root": { type: "string", default: layout.published },
        policy: { type: "string", default: qualityPolicy(layout) },
        fixtures: { type: "string", default: auditFixtures(layout) },
        write: { type: "boolean" },
      });
    } else {
      throw new CliUsageError("usage: auditDraftCli.ts <draft|suggest|render|import> [flags]");
    }
  } catch (e) {
    if (e instanceof CliUsageError) {
      io.err(`${e.message}\n`);
      return 2;
    }
    throw e;
  }

  if (command === "draft") {
    const docsRoot = parsed["docs-root"] as string;
    const outDir = parsed["out-dir"] as string;
    const strong = strongRelations(parsed.policy as string);
    const dblpPath = parsed["dblp-cache"] as string;
    let dblpVenues: Record<string, DblpVenueCacheEntry> | undefined;
    if (existsSync(dblpPath)) {
      const doc = JSON.parse(readFileSync(dblpPath, "utf8")) as { entries?: unknown };
      if (doc.entries && typeof doc.entries === "object") {
        dblpVenues = doc.entries as Record<string, DblpVenueCacheEntry>;
      }
    }
    for (const slug of parsed.theme as string[]) {
      const lineagePath = join(docsRoot, "themes", slug, "lineage.json");
      const bytes = readFileSync(lineagePath);
      const draft = buildAuditDraft({
        lineage: JSON.parse(bytes.toString("utf8")),
        lineageBytes: bytes,
        collectionId: `theme:${slug}`,
        lineagePath: relative(repoRoot, lineagePath) || lineagePath,
        generatedAt: io.now().toISOString(),
        strongRelations: strong,
        dblpVenues,
      });
      const jsonPath = join(outDir, `${slug}.audit-pending.json`);
      atomicWriteText(jsonPath, `${JSON.stringify(draft, null, 2)}\n`);
      atomicWriteText(sheetPathFor(jsonPath), renderAuditSheet(draft));
      io.out(
        `${slug}: nodes=${draft.nodes.length} strong_relations=${draft.relations.length} -> ${jsonPath}\n`,
      );
    }
    return 0;
  }

  if (command === "suggest") {
    const draftPath = parsed.draft as string;
    const draft = JSON.parse(readFileSync(draftPath, "utf8")) as AuditDraft;
    const file = JSON.parse(readFileSync(parsed.from as string, "utf8")) as SuggestionsFile;
    const result = applySuggestions(draft, file);
    if (result.unknown.length > 0) {
      io.err(
        `suggestions name items the draft lacks (stale file?):\n- ${result.unknown.join("\n- ")}\n`,
      );
      return 1;
    }
    atomicWriteText(draftPath, `${JSON.stringify(result.draft, null, 2)}\n`);
    atomicWriteText(sheetPathFor(draftPath), renderAuditSheet(result.draft));
    io.out(
      `suggested ${draft.nodes.length + draft.relations.length - result.missing.length} items` +
        `${result.missing.length > 0 ? ` (no suggestion: ${result.missing.length})` : ""} -> ${sheetPathFor(draftPath)}\n`,
    );
    return 0;
  }

  if (command === "render") {
    const draftPath = parsed.draft as string;
    const draft = JSON.parse(readFileSync(draftPath, "utf8")) as AuditDraft;
    atomicWriteText(sheetPathFor(draftPath), renderAuditSheet(draft));
    io.out(`rendered ${sheetPathFor(draftPath)}\n`);
    return 0;
  }

  // import
  const draftPath = parsed.draft as string;
  const docsRoot = parsed["docs-root"] as string;
  const draftBytes = readFileSync(draftPath);
  const draft = JSON.parse(draftBytes.toString("utf8")) as Record<string, unknown>;
  const slug = slugOf(String(draft.collection_id));
  const lineageBytes = readFileSync(join(docsRoot, "themes", slug, "lineage.json"));
  const policyPath = parsed.policy as string;
  let result: ReturnType<typeof importAuditDraft>;
  try {
    result = importAuditDraft({
      draft,
      draftBytes,
      lineage: JSON.parse(lineageBytes.toString("utf8")),
      lineageBytes,
      strongRelations: strongRelations(policyPath),
    });
  } catch (e) {
    if (e instanceof AuditImportError) {
      io.err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
  for (const w of result.warnings) io.err(`warning: ${w}\n`);
  const fixturesPath = parsed.fixtures as string;
  const merged = mergeFixtureEntry(JSON.parse(readFileSync(fixturesPath, "utf8")), result.entry);
  // Dry run through the real builder: what would this entry make the tier?
  const manifest = buildManifest({
    docsRoot,
    asOf: io
      .now()
      .toISOString()
      .replace(/\.\d+Z$/, "Z"),
    fixtures: merged,
    policy: JSON.parse(readFileSync(policyPath, "utf8")) as QualityPolicy,
  });
  const row = manifest.collections.find((c) => c.collection_id === result.entry.collection_id);
  const golden = row?.audit.checks.find((c) => c.name === "golden_fixture");
  io.out(`${JSON.stringify(result.entry, null, 2)}\n`);
  io.err(
    `stats: ${JSON.stringify(result.stats)}\n` +
      `dry-run: golden_fixture=${golden?.status ?? "n/a"} tier=${row?.publication_tier ?? "n/a"}` +
      `${golden && golden.evidence.length > 0 ? ` evidence=${golden.evidence.join(",")}` : ""}\n`,
  );
  if (parsed.write) {
    atomicWriteText(fixturesPath, `${JSON.stringify(merged, null, 2)}\n`);
    io.err(`wrote ${basename(fixturesPath)} (${result.entry.collection_id})\n`);
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = runAuditDraftCli(process.argv.slice(2));
}
