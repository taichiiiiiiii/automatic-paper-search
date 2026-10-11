#!/usr/bin/env node
/**
 * CLI for {@link planApproval} — the single command the `conference-watch`
 * issue points to (R3-4, design 52 §8.6). Default is a dry run that prints
 * the plan; `--execute` runs it in the repo root and stops at the first
 * failing step. Never commits, pushes or deploys.
 *
 *   pnpm exec tsx apps/pipeline/src/conference/watch/approveCli.ts --edition iclr-2025
 *   pnpm exec tsx apps/pipeline/src/conference/watch/approveCli.ts --edition iclr-2025 --execute
 *   … --edition icml-2027 --pmlr-volume 320 --execute
 *   … --edition neurips-2026 --adapter virtual-export --allow-virtual-site   # only after design 52 D6
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../../shared/cli/isMain.js";
import { CliUsageError, parseCliArgs } from "../shared/cliArgs.js";
import {
  type ApproveAdapter,
  type ApproveEdition,
  editionFrom,
  planApproval,
  renderCommand,
} from "./approve.js";
import { EditionsConfigSchema, PendingEditionsFileSchema, ProceedingsAdapter } from "./groups.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/conference/watch -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export const PENDING_PATH = "data/state/conference-watch/pending-editions-v1.json";
export const EDITIONS_CONFIG_PATH = "data/config/conference-editions-v1.json";
export const QUALITY_PATH = "data/published/lineage-quality-v1.json";

const ARG_SPEC = {
  edition: { type: "string", required: true } as const,
  adapter: { type: "string" } as const,
  "pmlr-volume": { type: "int" } as const,
  "acl-xml-id": { type: "string" } as const,
  "allow-virtual-site": { type: "boolean" } as const,
  "virtual-input": { type: "string" } as const,
  execute: { type: "boolean" } as const,
};

export interface ApproveCliDeps {
  root?: string;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  run?: (argv: string[], env: Record<string, string>, cwd: string) => number;
  print?: (line: string) => void;
}

/**
 * The edition: the pending record when the watcher has one, otherwise
 * derived from the editions config (`<venue_key>-<year>` slug) so a
 * re-build or an edition the watcher cannot see (OpenReview blocked) still
 * works.
 */
export function resolveEdition(
  id: string,
  pendingRaw: string | null,
  configRaw: string,
): ApproveEdition | null {
  if (pendingRaw !== null) {
    const pending = PendingEditionsFileSchema.parse(JSON.parse(pendingRaw));
    const hit = pending.editions.find((e) => e.edition_id === id);
    if (hit) return editionFrom(hit);
  }
  const config = EditionsConfigSchema.parse(JSON.parse(configRaw));
  for (const venue of config.venues) {
    const m = new RegExp(`^${venue.slug_template.replace("{year}", "((?:19|20)\\d{2})")}$`).exec(
      id,
    );
    if (!m) continue;
    const year = Number(m[1]);
    return {
      edition_id: id,
      venue_key: venue.venue_key,
      year,
      display_name: venue.display_template.replace("{year}", String(year)),
      proceedings_adapter: venue.proceedings_adapter,
    };
  }
  return null;
}

function defaultRun(argv: string[], env: Record<string, string>, cwd: string): number {
  const [cmd, ...rest] = argv;
  const r = spawnSync(cmd as string, rest, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  return r.status ?? 1;
}

/** 0 = plan printed / executed, 1 = refused or a step failed. Usage errors throw. */
export function runApproveCli(argv: readonly string[], deps: ApproveCliDeps = {}): number {
  const args = parseCliArgs(argv, ARG_SPEC);
  const root = deps.root ?? DEFAULT_REPO_ROOT;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const exists = deps.exists ?? existsSync;
  const print = deps.print ?? ((l: string) => console.log(l));
  const id = args.edition as string;

  let adapter: ApproveAdapter | undefined;
  if (args.adapter !== undefined) {
    const a = args.adapter as string;
    if (a !== "virtual-export" && !ProceedingsAdapter.safeParse(a).success) {
      throw new CliUsageError(
        `--adapter must be one of: ${[...ProceedingsAdapter.options, "virtual-export"].join(", ")}`,
      );
    }
    adapter = a as ApproveAdapter;
  }

  const pendingFile = join(root, PENDING_PATH);
  const edition = resolveEdition(
    id,
    exists(pendingFile) ? readFile(pendingFile) : null,
    readFile(join(root, EDITIONS_CONFIG_PATH)),
  );
  if (edition === null) {
    print(
      `⚠️  ${id} is neither a pending edition nor a <venue>-<year> slug of ${EDITIONS_CONFIG_PATH}.`,
    );
    return 1;
  }
  const asOf = (JSON.parse(readFile(join(root, QUALITY_PATH))) as { as_of?: unknown }).as_of;
  if (typeof asOf !== "string" || asOf === "") {
    print(
      `⚠️  ${QUALITY_PATH} has no as_of; cannot run the refresh chain at the committed instant.`,
    );
    return 1;
  }

  const plan = planApproval(edition, {
    tree: root,
    asOf,
    adapter,
    pmlrVolume: args["pmlr-volume"] as number | undefined,
    aclXmlId: args["acl-xml-id"] as string | undefined,
    allowVirtualSite: Boolean(args["allow-virtual-site"]),
    virtualInput: args["virtual-input"] as string | undefined,
  });
  print(`# ${edition.display_name} (${edition.edition_id}) — adapter ${plan.adapter}`);
  if (!plan.ok) {
    print(`⚠️  ${plan.reason}`);
    return 1;
  }
  plan.commands.forEach((c, i) => {
    print(`${i + 1}. ${c.label}`);
    print(`   ${renderCommand(c)}`);
  });
  if (!args.execute) {
    print("(dry run — add --execute to build locally; nothing is committed or published)");
    return 0;
  }
  const run = deps.run ?? defaultRun;
  for (const [i, c] of plan.commands.entries()) {
    print(`==> ${i + 1}/${plan.commands.length} ${c.label}`);
    const code = run(c.argv, c.env ?? {}, root);
    if (code !== 0) {
      print(`⚠️  step ${i + 1} (${c.label}) exited ${code}; stopped. Nothing is committed.`);
      return 1;
    }
  }
  print(
    `✅ ${edition.edition_id} built locally. Next: review \`git status\` (data/inputs/${edition.edition_id}/, ` +
      `data/published/), run the gates, commit the inputs and the regenerated data as separate commits, open a PR.`,
  );
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = runApproveCli(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliUsageError) {
      console.error(e.message);
      process.exitCode = 2;
    } else {
      throw e;
    }
  }
}
