#!/usr/bin/env node
/**
 * New-edition watcher CLI (OpenReview `/groups`; see `./groups.ts`).
 *
 *   pnpm exec tsx apps/pipeline/src/conference/watch/groupsCli.ts \
 *     [--config data/config/conference-editions-v1.json] \
 *     [--published data/published/conferences.json] \
 *     [--state data/state/conference-watch/pending-editions-v1.json] [--write]
 *
 * Dry-run by default (prints the would-be state). `--write` updates the
 * state file atomically. Exit codes: 0 ok, 1 error, 3 source_blocked.
 * Requests: 1 for `/groups?id=venues` plus 1 per newly announced edition
 * (start date / location), at most {@link MAX_GROUP_DETAIL_FETCHES}, 1 s apart.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { isMain } from "../../shared/cli/isMain.js";
import { CliUsageError, parseCliArgs } from "../shared/cliArgs.js";
import {
  detectPendingEditions,
  EditionsConfigSchema,
  emptyPendingEditions,
  fetchGroupInfo,
  fetchVenueIds,
  type GroupInfo,
  type GroupsFetch,
  PendingEditionsFileSchema,
  recordFailedCheck,
  watchedEditions,
} from "./groups.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
export const MAX_GROUP_DETAIL_FETCHES = 10;
export const EXIT_SOURCE_BLOCKED = 3;
const USER_AGENT = "PaperPilot/1.0 (+https://paperpilot.pages.dev; new-edition watcher)";

export interface GroupsCliDeps {
  fetchJson: GroupsFetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  print?: (line: string) => void;
  repoRoot?: string;
}

const ARG_SPEC = {
  config: { type: "string", default: "data/config/conference-editions-v1.json" } as const,
  published: { type: "string", default: "data/published/conferences.json" } as const,
  state: {
    type: "string",
    default: "data/state/conference-watch/pending-editions-v1.json",
  } as const,
  write: { type: "boolean" } as const,
};

function publishedSlugs(path: string): Set<string> {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${path}: expected a JSON array`);
  return new Set(
    raw
      .map((c) => (c as { name?: unknown }).name)
      .filter((n): n is string => typeof n === "string"),
  );
}

export async function runGroupsCli(argv: readonly string[], deps: GroupsCliDeps): Promise<number> {
  const args = parseCliArgs(argv, ARG_SPEC);
  const root = deps.repoRoot ?? REPO_ROOT;
  const at = (p: string) => (p.startsWith("/") ? p : join(root, p));
  const print = deps.print ?? ((l: string) => console.log(l));
  const now = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const config = EditionsConfigSchema.parse(
    JSON.parse(readFileSync(at(args.config as string), "utf-8")),
  );
  const statePath = at(args.state as string);
  const previous = existsSync(statePath)
    ? PendingEditionsFileSchema.parse(JSON.parse(readFileSync(statePath, "utf-8")))
    : emptyPendingEditions();
  const published = publishedSlugs(at(args.published as string));

  const venues = await fetchVenueIds(deps.fetchJson);
  let next = previous;
  let code = 0;
  if (venues.status !== "ok") {
    next = recordFailedCheck(previous, venues, now);
    code = venues.status === "source_blocked" ? EXIT_SOURCE_BLOCKED : 1;
    print(`⛔ ${venues.status}: ${next.last_check?.detail} — pending editions left unchanged.`);
  } else {
    const listed = new Set(venues.value);
    const known = new Set(previous.editions.map((e) => e.edition_id));
    const toDescribe = watchedEditions(config, now)
      .filter((w) => listed.has(w.groupId) && !published.has(w.slug) && !known.has(w.slug))
      .slice(0, MAX_GROUP_DETAIL_FETCHES);
    const groupInfo = new Map<string, GroupInfo>();
    for (const [i, w] of toDescribe.entries()) {
      if (i > 0) await sleep(1000);
      const info = await fetchGroupInfo(w.groupId, deps.fetchJson);
      if (info.status === "ok") groupInfo.set(w.groupId, info.value);
    }
    const out = detectPendingEditions({
      config,
      venueIds: venues.value,
      publishedSlugs: published,
      previous,
      now,
      groupInfo,
    });
    next = out.state;
    print(
      `announced (new): ${out.newlyAnnounced.join(", ") || "none"}; ` +
        `resolved (now published): ${out.resolved.join(", ") || "none"}; ` +
        `pending: ${next.editions.map((e) => e.edition_id).join(", ") || "none"}`,
    );
  }

  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (args.write) {
    mkdirSync(dirname(statePath), { recursive: true });
    atomicWriteText(statePath, text);
    print(`wrote ${statePath}`);
  } else {
    print(text.trimEnd());
    print("(dry-run: pass --write to update the state file)");
  }
  return code;
}

if (isMain(import.meta.url)) {
  runGroupsCli(process.argv.slice(2), {
    fetchJson: (url) =>
      fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      }),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      if (e instanceof CliUsageError) {
        console.error(e.message);
        process.exitCode = 2;
        return;
      }
      throw e;
    });
}
