/**
 * "Approve a pending edition -> build its catalog from the official source"
 * (R3-4, design 52 §8.6). One command the `conference-watch` issue points
 * to:
 *
 *   pnpm exec tsx apps/pipeline/src/conference/watch/approveCli.ts --edition <id>            # plan only
 *   pnpm exec tsx apps/pipeline/src/conference/watch/approveCli.ts --edition <id> --execute  # build locally
 *
 * The plan is: collect from the edition's `proceedings_adapter` (into
 * `data/inputs/<id>/`, with `source_license.json`) -> display copy
 * (`conference/scaffold`, display/lede from templates, no LLM) ->
 * `buildSummaryCli` -> promote's conference refresh chain
 * (`refreshCommandsFor("conference")`: buildPages for every conference,
 * identityLite / searchIndex / lineageQuality at the committed `as_of`).
 * It never commits, pushes or deploys: the operator reviews `git status`,
 * runs the gates and opens a PR, and the normal release path publishes.
 *
 * Adapters without an official listing (`none`) are refused with the
 * arXiv fallback (`conference-on-demand.yml`) as the documented
 * alternative; `virtual-export` is gated on design 52 D6.
 */

import { refreshCommandsFor } from "../../release/promoteHooks.js";
import type { PendingEdition, ProceedingsAdapter } from "./groups.js";

export interface ApproveEdition {
  edition_id: string;
  venue_key: string;
  year: number;
  display_name: string;
  proceedings_adapter: ProceedingsAdapter;
}

export interface ApproveOptions {
  /** Repo root the commands run in. */
  tree: string;
  /** `as_of` of the committed `lineage-quality-v1.json` (parity with promote). */
  asOf: string;
  /** Adapter override (e.g. `virtual-export` for an edition whose proceedings are not out). */
  adapter?: ApproveAdapter;
  /** PMLR volume number (required for `pmlr`). */
  pmlrVolume?: number;
  /** ACL Anthology XML id override (default `<year>.<venue_key>`). */
  aclXmlId?: string;
  /** Design 52 D6 gate for `virtual-export`. */
  allowVirtualSite?: boolean;
  /** Local CSV downloaded from the virtual site's Downloads page. */
  virtualInput?: string;
}

/** Adapters the approve command can run (the watch config's enum plus `virtual-export`). */
export type ApproveAdapter = ProceedingsAdapter | "virtual-export";

export interface PlannedCommand {
  label: string;
  argv: string[];
  env?: Record<string, string>;
}

export type ApprovePlan =
  | { ok: true; edition: ApproveEdition; adapter: ApproveAdapter; commands: PlannedCommand[] }
  | { ok: false; edition: ApproveEdition; adapter: ApproveAdapter; reason: string };

const TSX = ["pnpm", "exec", "tsx"];
const INPUTS_ENV = { PAPERPILOT_OUTPUT_ROOT: "data/inputs" };

/** Human label of each adapter's source (lede text and plan output). */
export const ADAPTER_SOURCE_LABEL: Record<ApproveAdapter, string> = {
  pmlr: "PMLR（Proceedings of Machine Learning Research）",
  "acl-anthology": "ACL Anthology",
  "cvf-listing": "CVF Open Access",
  "neurips-proceedings": "NeurIPS Proceedings",
  "iclr-proceedings": "ICLR Proceedings",
  ecva: "ECVA Open Access",
  "virtual-export": "学会の公式サイト（Downloads の一覧）",
  none: "",
};

/** Adapters whose catalogs carry no abstracts (titles, authors, links). */
const LISTING_ONLY: ReadonlySet<ApproveAdapter> = new Set([
  "cvf-listing",
  "neurips-proceedings",
  "iclr-proceedings",
  "ecva",
  "virtual-export",
]);

export function editionFrom(pending: PendingEdition): ApproveEdition {
  return {
    edition_id: pending.edition_id,
    venue_key: pending.venue_key,
    year: pending.year,
    display_name: pending.display_name,
    proceedings_adapter: pending.proceedings_adapter,
  };
}

/** Display copy written via `conference/scaffold/cli.ts` (DISPLAY / LEDE env). */
export function displayCopy(
  edition: ApproveEdition,
  adapter: ApproveAdapter,
): { display: string; lede: string } {
  const source = ADAPTER_SOURCE_LABEL[adapter];
  const scope = LISTING_ONLY.has(adapter)
    ? "タイトル・著者・リンクを収録しています（要旨は出典のライセンスにより掲載しません）。"
    : "タイトル・著者・要旨を収録しています。";
  return {
    display: edition.display_name,
    lede: `${source} の ${edition.display_name} 採択論文の一覧です。${scope}キーワード検索・トピックタグ・並び替えで絞り込めます。`,
  };
}

function collectCommand(
  edition: ApproveEdition,
  adapter: ApproveAdapter,
  opts: ApproveOptions,
): PlannedCommand | string {
  const id = edition.edition_id;
  const venue = edition.venue_key.toUpperCase();
  const year = String(edition.year);
  const site = (kind: string, extra: string[]): PlannedCommand => ({
    label: `collect (${adapter})`,
    argv: [
      ...TSX,
      "apps/pipeline/src/conference/site/cli.ts",
      "--conference",
      id,
      "--venue",
      venue,
      "--kind",
      kind,
      "--year",
      year,
      ...extra,
    ],
    env: INPUTS_ENV,
  });
  switch (adapter) {
    case "pmlr":
      if (!opts.pmlrVolume) {
        return "pmlr needs --pmlr-volume <n> (the volume number on https://proceedings.mlr.press/).";
      }
      return {
        label: "collect (pmlr)",
        argv: [
          ...TSX,
          "apps/pipeline/src/conference/pmlr/cli.ts",
          "--conference",
          id,
          "--venue",
          venue,
          "--volume",
          String(opts.pmlrVolume),
        ],
        env: INPUTS_ENV,
      };
    case "acl-anthology":
      return {
        label: "collect (acl-anthology)",
        argv: [
          ...TSX,
          "apps/pipeline/src/conference/acl/cli.ts",
          "--conference",
          id,
          "--venue",
          venue,
          "--xml-id",
          opts.aclXmlId ?? `${year}.${edition.venue_key}`,
        ],
        env: INPUTS_ENV,
      };
    case "cvf-listing":
      return {
        label: "collect (cvf-listing)",
        argv: [
          ...TSX,
          "apps/pipeline/src/conference/cvf/cli.ts",
          "--conference",
          id,
          "--venue",
          venue,
          "--cvf-id",
          `${venue}${year}`,
          "--listing-only",
        ],
        env: INPUTS_ENV,
      };
    case "neurips-proceedings":
      return site("proceedings", ["--site", "neurips"]);
    case "iclr-proceedings":
      return site("proceedings", ["--site", "iclr"]);
    case "ecva":
      return site("ecva", []);
    case "virtual-export":
      if (!opts.allowVirtualSite) {
        return (
          "virtual-export uses the conference virtual site's Downloads export, which is pending " +
          "user decision D6 (design 52 §8.6); pass --allow-virtual-site only once D6 is approved."
        );
      }
      return site("virtual-export", [
        "--site",
        edition.venue_key,
        "--allow-virtual-site",
        ...(opts.virtualInput ? ["--input", opts.virtualInput] : []),
      ]);
    case "none":
      return (
        `${edition.display_name} has no official listing adapter. Fallback (arXiv comments, partial ` +
        `coverage): gh workflow run conference-on-demand.yml --ref develop -f conference=${id} -f venue=${venue} ` +
        `-f query='co:"${edition.display_name}"' -f display='${edition.display_name}' ` +
        `-f lede='${edition.display_name} の論文一覧。'`
      );
  }
}

/** Build the full command plan for one edition (pure). */
export function planApproval(edition: ApproveEdition, opts: ApproveOptions): ApprovePlan {
  const adapter = opts.adapter ?? edition.proceedings_adapter;
  const collect = collectCommand(edition, adapter, opts);
  if (typeof collect === "string") return { ok: false, edition, adapter, reason: collect };
  const copy = displayCopy(edition, adapter);
  const refresh = refreshCommandsFor("conference", opts.tree, opts.asOf).filter(
    (argv) => argv[0] !== "pnpm" || argv[1] !== "install",
  );
  const commands: PlannedCommand[] = [
    collect,
    {
      label: "display copy (scaffold)",
      argv: [
        ...TSX,
        "apps/pipeline/src/conference/scaffold/cli.ts",
        "--conference",
        edition.edition_id,
      ],
      env: { DISPLAY: copy.display, LEDE: copy.lede },
    },
    {
      label: "summary.csv",
      argv: [
        ...TSX,
        "apps/pipeline/src/catalog/buildSummaryCli.ts",
        "--conference",
        edition.edition_id,
      ],
    },
    ...refresh.map((argv) => ({ label: `refresh: ${argv[3] ?? argv.join(" ")}`, argv: [...argv] })),
  ];
  return { ok: true, edition, adapter, commands };
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`;
}

/** One shell line per command (for the plan printout and the issue). */
export function renderCommand(cmd: PlannedCommand): string {
  const env = Object.entries(cmd.env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return [...env, ...cmd.argv.map(shellQuote)].join(" ");
}
