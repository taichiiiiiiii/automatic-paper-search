/**
 * New-edition watcher over OpenReview `/groups` — design 52 §4.2 step
 * `unseen → announced`, user decision D5=A.
 *
 * OpenReview `/notes` refuses scripts (403 ChallengeRequiredError), but
 * `/groups` still answers: `/groups?id=venues` lists every venue group id
 * (e.g. `ICML.cc/2026/Conference`) and `/groups?id=<venue>` carries the
 * start date and location. That is enough to know a new edition EXISTS, so
 * this module turns it into a pending-edition record — R3 state
 * `announced`, `status: pending_approval`, `auto_publish: false`.
 *
 * It never collects papers and never publishes: the catalog is built later
 * from the official proceedings named by `proceedings_adapter` (PMLR, ACL
 * Anthology, CVF listing, …), and a human approves the publish. A 403 or
 * any fetch failure leaves the previous records untouched (explicit
 * `source_blocked` / `error` status, never an empty list).
 */

import { z } from "zod";

export const GROUPS_API = "https://api2.openreview.net/groups";
export const EDITIONS_CONFIG_SCHEMA = "conference-editions-v1";
export const PENDING_EDITIONS_SCHEMA = "conference-pending-editions-v1";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const ProceedingsAdapter = z.enum([
  "pmlr",
  "acl-anthology",
  "cvf-listing",
  "neurips-proceedings",
  "none",
]);
export type ProceedingsAdapter = z.infer<typeof ProceedingsAdapter>;

export const EditionWatchVenueSchema = z
  .object({
    venue_key: z.string().regex(/^[a-z0-9-]+$/),
    display_template: z.string().includes("{year}"),
    slug_template: z.string().includes("{year}"),
    group_id_template: z.string().includes("{year}"),
    proceedings_adapter: ProceedingsAdapter,
    /** Free text for the operator: where/when the official proceedings appear. */
    proceedings_hint: z.string().max(500),
  })
  .strict();
export type EditionWatchVenue = z.infer<typeof EditionWatchVenueSchema>;

export const EditionsConfigSchema = z
  .object({
    schema_version: z.literal(EDITIONS_CONFIG_SCHEMA),
    /** Must stay false: this watcher only proposes; publishing is a human approval. */
    auto_publish: z.literal(false),
    years_back: z.number().int().min(0).max(2),
    years_ahead: z.number().int().min(0).max(2),
    venues: z.array(EditionWatchVenueSchema).min(1).max(64),
  })
  .strict()
  .refine((c) => new Set(c.venues.map((v) => v.venue_key)).size === c.venues.length, {
    message: "venue_key must be unique",
  });
export type EditionsConfig = z.infer<typeof EditionsConfigSchema>;

export const PendingEditionSchema = z
  .object({
    edition_id: z.string().regex(SLUG_RE),
    venue_key: z.string(),
    year: z.number().int().min(2000).max(2100),
    display_name: z.string().min(1),
    openreview_group_id: z.string().min(1).max(256),
    phase: z.literal("announced"),
    status: z.literal("pending_approval"),
    auto_publish: z.literal(false),
    first_seen_at: z.string(),
    last_seen_at: z.string(),
    /** False once the group id is no longer in `/groups?id=venues` (record is kept, never dropped). */
    listed: z.boolean(),
    start_date: z.string().nullable(),
    location: z.string().nullable(),
    proceedings_adapter: ProceedingsAdapter,
    proceedings_hint: z.string(),
  })
  .strict();
export type PendingEdition = z.infer<typeof PendingEditionSchema>;

export const LastCheckSchema = z
  .object({
    status: z.enum(["ok", "source_blocked", "error"]),
    checked_at: z.string(),
    detail: z.string(),
  })
  .strict();
export type LastCheck = z.infer<typeof LastCheckSchema>;

export const PendingEditionsFileSchema = z
  .object({
    schema_version: z.literal(PENDING_EDITIONS_SCHEMA),
    last_check: LastCheckSchema.nullable(),
    editions: z.array(PendingEditionSchema),
  })
  .strict();
export type PendingEditionsFile = z.infer<typeof PendingEditionsFileSchema>;

export function emptyPendingEditions(): PendingEditionsFile {
  return { schema_version: PENDING_EDITIONS_SCHEMA, last_check: null, editions: [] };
}

// ---------------------------------------------------------------------------
// Fetching (injected transport)
// ---------------------------------------------------------------------------

export interface GroupsResponse {
  status: number;
  json(): Promise<unknown>;
}
export type GroupsFetch = (url: string) => Promise<GroupsResponse>;

export type GroupsFetchResult<T> =
  | { status: "ok"; value: T }
  | { status: "source_blocked"; httpStatus: number; errorName: string | null }
  | { status: "error"; detail: string };

async function fetchGroups(
  id: string,
  fetchJson: GroupsFetch,
): Promise<GroupsFetchResult<Record<string, unknown>[]>> {
  let resp: GroupsResponse;
  try {
    resp = await fetchJson(`${GROUPS_API}?id=${encodeURIComponent(id)}`);
  } catch (e) {
    return { status: "error", detail: `request failed: ${(e as Error).message ?? e}` };
  }
  if (resp.status === 403) {
    let errorName: string | null = null;
    try {
      const body = (await resp.json()) as { name?: unknown } | null;
      if (body && typeof body.name === "string") errorName = body.name;
    } catch {
      // unnamed 403
    }
    return { status: "source_blocked", httpStatus: 403, errorName };
  }
  if (resp.status !== 200) return { status: "error", detail: `HTTP ${resp.status}` };
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return { status: "error", detail: "non-JSON body" };
  }
  const groups = (body as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) return { status: "error", detail: "body has no groups array" };
  return { status: "ok", value: groups as Record<string, unknown>[] };
}

/** `/groups?id=venues` → every venue group id. */
export async function fetchVenueIds(fetchJson: GroupsFetch): Promise<GroupsFetchResult<string[]>> {
  const r = await fetchGroups("venues", fetchJson);
  if (r.status !== "ok") return r;
  const members = r.value[0]?.members;
  if (
    !Array.isArray(members) ||
    members.length === 0 ||
    !members.every((m) => typeof m === "string")
  ) {
    // An empty or malformed list is a source problem, not "no venues exist".
    return { status: "error", detail: "venues group has no members list" };
  }
  return { status: "ok", value: members as string[] };
}

export interface GroupInfo {
  startDate: string | null;
  location: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** OpenReview's `start_date` ("Jul 06 2026") → `2026-07-06`; anything else → null. */
export function parseOpenReviewDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^([A-Z][a-z]{2}) (\d{1,2}) (\d{4})$/.exec(value.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1] as string);
  const day = Number(m[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function contentString(content: unknown, key: string): string | null {
  const node = (content as Record<string, unknown> | null)?.[key];
  const v = (node as { value?: unknown } | null)?.value;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** `/groups?id=<venue group>` → start date and location (best effort). */
export async function fetchGroupInfo(
  groupId: string,
  fetchJson: GroupsFetch,
): Promise<GroupsFetchResult<GroupInfo>> {
  const r = await fetchGroups(groupId, fetchJson);
  if (r.status !== "ok") return r;
  const content = r.value[0]?.content;
  return {
    status: "ok",
    value: {
      startDate: parseOpenReviewDate(contentString(content, "start_date")),
      location: contentString(content, "location"),
    },
  };
}

// ---------------------------------------------------------------------------
// Pure state transition
// ---------------------------------------------------------------------------

export interface DetectInput {
  config: EditionsConfig;
  venueIds: readonly string[];
  /** Slugs already in `data/published/conferences.json`. */
  publishedSlugs: ReadonlySet<string>;
  previous: PendingEditionsFile;
  now: Date;
  /** Group details fetched for (some) candidate group ids. */
  groupInfo?: ReadonlyMap<string, GroupInfo>;
}

export interface DetectOutput {
  state: PendingEditionsFile;
  /** Edition ids announced for the first time in this run. */
  newlyAnnounced: string[];
  /** Pending edition ids removed because their catalog is now published. */
  resolved: string[];
}

function fill(template: string, year: number): string {
  return template.replaceAll("{year}", String(year));
}

/** Candidate (venue, year, group id) triples the config watches at `now`. */
export function watchedEditions(
  config: EditionsConfig,
  now: Date,
): { venue: EditionWatchVenue; year: number; groupId: string; slug: string }[] {
  const nowYear = now.getUTCFullYear();
  const out = [];
  for (const venue of config.venues) {
    for (let year = nowYear - config.years_back; year <= nowYear + config.years_ahead; year++) {
      out.push({
        venue,
        year,
        groupId: fill(venue.group_id_template, year),
        slug: fill(venue.slug_template, year),
      });
    }
  }
  return out;
}

/** Apply one successful `/groups?id=venues` observation. Never drops an unpublished record. */
export function detectPendingEditions(input: DetectInput): DetectOutput {
  const at = input.now.toISOString();
  const listed = new Set(input.venueIds);
  const byId = new Map(input.previous.editions.map((e) => [e.edition_id, e]));
  const newlyAnnounced: string[] = [];
  const resolved: string[] = [];

  for (const { venue, year, groupId, slug } of watchedEditions(input.config, input.now)) {
    if (!SLUG_RE.test(slug))
      throw new RangeError(`slug_template produced an invalid slug: ${slug}`);
    if (!listed.has(groupId) || input.publishedSlugs.has(slug)) continue;
    const prev = byId.get(slug);
    const info = input.groupInfo?.get(groupId);
    if (!prev) newlyAnnounced.push(slug);
    byId.set(slug, {
      edition_id: slug,
      venue_key: venue.venue_key,
      year,
      display_name: fill(venue.display_template, year),
      openreview_group_id: groupId,
      phase: "announced",
      status: "pending_approval",
      auto_publish: false,
      first_seen_at: prev?.first_seen_at ?? at,
      last_seen_at: at,
      listed: true,
      start_date: info?.startDate ?? prev?.start_date ?? null,
      location: info?.location ?? prev?.location ?? null,
      proceedings_adapter: venue.proceedings_adapter,
      proceedings_hint: venue.proceedings_hint,
    });
  }

  for (const [id, record] of byId) {
    if (input.publishedSlugs.has(id)) {
      byId.delete(id);
      resolved.push(id);
    } else if (!listed.has(record.openreview_group_id)) {
      byId.set(id, { ...record, listed: false });
    }
  }

  const editions = [...byId.values()].sort((a, b) =>
    a.edition_id < b.edition_id ? -1 : a.edition_id > b.edition_id ? 1 : 0,
  );
  return {
    state: {
      schema_version: PENDING_EDITIONS_SCHEMA,
      last_check: {
        status: "ok",
        checked_at: at,
        detail: `${input.venueIds.length} venue ids; ${editions.length} pending`,
      },
      editions,
    },
    newlyAnnounced: newlyAnnounced.sort(),
    resolved: resolved.sort(),
  };
}

/** Record a failed check without touching any edition record. */
export function recordFailedCheck(
  previous: PendingEditionsFile,
  result:
    | { status: "source_blocked"; httpStatus: number; errorName: string | null }
    | { status: "error"; detail: string },
  now: Date,
): PendingEditionsFile {
  const detail =
    result.status === "source_blocked"
      ? `OpenReview /groups answered ${result.httpStatus}${result.errorName ? ` ${result.errorName}` : ""}`
      : result.detail;
  return {
    ...previous,
    last_check: { status: result.status, checked_at: now.toISOString(), detail },
  };
}
