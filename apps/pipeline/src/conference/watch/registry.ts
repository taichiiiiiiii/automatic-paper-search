/**
 * Closed curated registry loading and bounded edition planning — TS port
 * of `paperpilot/conference_watch/registry.py` (CNF-26/37).
 *
 * Uses the `yaml` package (already a dependency of this package — no new
 * dep added), which rejects duplicate mapping keys by default
 * (`uniqueKeys: true`), matching Python's custom `_UniqueKeyLoader`.
 */

import { parse as parseYaml } from "yaml";
import {
  type ConferenceRegistry,
  ConferenceRegistrySchema,
  type CountGate,
  type Edition,
  type RegistryDefaults,
  RegistryError,
  type TrackPolicy,
  type Venue,
} from "./models.js";

export const SCHEMA_VERSION = "conference-sources-v1";
export const SUPPORTED_ADAPTER = "openreview-v2";
export const STABLE_PROBE_COUNT = 2;
export const MAX_REGISTRY_BYTES = 64 * 1024;
export const MAX_REGISTRY_NODES = 10_000;
export const MAX_REGISTRY_DEPTH = 12;

const VENUE_KEY_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}\/[0-9]{4}\/Conference$/;

const TOP_KEYS = new Set(["schema_version", "apply_enabled", "defaults", "venues"]);
const DEFAULT_KEYS = new Set([
  "probe_interval_hours",
  "stable_min_separation_hours",
  "stable_max_separation_hours",
  "max_future_years",
]);
const VENUE_KEYS = new Set([
  "venue_key",
  "enabled",
  "curated_class",
  "display_template",
  "slug_template",
  "adapter",
  "source_id_template",
  "first_year",
  "active_months_utc",
  "count_gate",
  "tracks",
]);
const COUNT_KEYS = new Set([
  "minimum_absolute",
  "previous_edition_min_ratio",
  "previous_edition_max_ratio",
]);
const TRACK_KEYS = new Set(["accepted_only", "accepted_decision_labels", "highlighted_labels"]);

function fail(message: string): never {
  throw new RegistryError(message);
}

function closed(
  value: unknown,
  expected: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const keys = new Set(Object.keys(raw));
  const missing = [...expected].filter((k) => !keys.has(k)).sort();
  const unknown = [...keys].filter((k) => !expected.has(k)).sort();
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `${label} keys are not closed (missing=${JSON.stringify(missing)}, unknown=${JSON.stringify(unknown)})`,
    );
  }
  return raw;
}

/** Cycle-safe structural walk (node count / depth / recursive-alias limits). */
function validateStructure(value: unknown): void {
  let nodes = 0;
  const active = new Set<unknown>();

  function walk(item: unknown, depth: number): void {
    nodes += 1;
    if (nodes > MAX_REGISTRY_NODES || depth > MAX_REGISTRY_DEPTH) {
      fail("conference registry exceeds structural limits");
    }
    if (item !== null && typeof item === "object") {
      if (active.has(item)) fail("conference registry must not contain recursive aliases");
      active.add(item);
      try {
        if (Array.isArray(item)) {
          for (const child of item) walk(child, depth + 1);
        } else {
          for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
            walk(key, depth + 1);
            walk(child, depth + 1);
          }
        }
      } finally {
        active.delete(item);
      }
    } else if (
      item !== null &&
      item !== undefined &&
      !["string", "number", "boolean"].includes(typeof item)
    ) {
      fail("conference registry contains an unsupported YAML value");
    }
  }

  walk(value, 0);
}

function plainInt(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function ratio(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a number`);
  const result = value;
  if (!(result > 0 && result <= 10)) fail(`${label} must be in (0, 10]`);
  return result;
}

function str(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    fail(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

/** Expand the sole supported `{year}` template token, rejecting all other format syntax. */
export function expandYearTemplate(template: string, year: number, label: string): string {
  const checked = str(template, label);
  const occurrences = checked.split("{year}").length - 1;
  if (occurrences !== 1) fail(`${label} must contain exactly one {year} token`);
  const remainder = checked.replace("{year}", "");
  if (remainder.includes("{") || remainder.includes("}")) {
    fail(`${label} contains forbidden template syntax`);
  }
  return checked.replace("{year}", String(year));
}

const LABEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function labels(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  if (value.some((item) => typeof item !== "string" || !LABEL_RE.test(item))) {
    fail(`${label} contains an invalid decision label`);
  }
  const arr = value as string[];
  if (new Set(arr).size !== arr.length) fail(`${label} must not contain duplicates`);
  return arr;
}

/** Validate an already-decoded closed registry and return typed values — TS port of `parse_registry`. */
export function parseRegistry(value: unknown): ConferenceRegistry {
  const root = closed(value, TOP_KEYS, "registry");
  if (root.schema_version !== SCHEMA_VERSION)
    fail(`schema_version must equal ${JSON.stringify(SCHEMA_VERSION)}`);
  if (typeof root.apply_enabled !== "boolean") fail("apply_enabled must be boolean");

  const rawDefaults = closed(root.defaults, DEFAULT_KEYS, "defaults");
  const defaults: RegistryDefaults = {
    probeIntervalHours: plainInt(rawDefaults.probe_interval_hours, "probe_interval_hours", 1, 24),
    stableMinSeparationHours: plainInt(
      rawDefaults.stable_min_separation_hours,
      "stable_min_separation_hours",
      1,
      168,
    ),
    stableMaxSeparationHours: plainInt(
      rawDefaults.stable_max_separation_hours,
      "stable_max_separation_hours",
      1,
      336,
    ),
    maxFutureYears: plainInt(rawDefaults.max_future_years, "max_future_years", 0, 1),
  };
  if (defaults.stableMaxSeparationHours < defaults.stableMinSeparationHours) {
    fail("stable_max_separation_hours must be >= minimum");
  }

  const rawVenues = root.venues;
  if (!Array.isArray(rawVenues) || rawVenues.length < 1 || rawVenues.length > 32) {
    fail("venues must contain between 1 and 32 entries");
  }
  const venues: Venue[] = [];
  const seenKeys = new Set<string>();
  rawVenues.forEach((rawValue, index) => {
    const raw = closed(rawValue, VENUE_KEYS, `venues[${index}]`);
    const key = str(raw.venue_key, `venues[${index}].venue_key`);
    if (!VENUE_KEY_RE.test(key) || key === "daily")
      fail(`invalid or reserved venue_key: ${JSON.stringify(key)}`);
    if (seenKeys.has(key)) fail(`duplicate venue_key: ${JSON.stringify(key)}`);
    seenKeys.add(key);
    if (typeof raw.enabled !== "boolean") fail(`venues[${index}].enabled must be boolean`);
    if (raw.curated_class !== "top") fail("curated_class must equal 'top'");
    if (raw.adapter !== SUPPORTED_ADAPTER)
      fail(`unsupported adapter: ${JSON.stringify(raw.adapter)}`);

    const countRaw = closed(raw.count_gate, COUNT_KEYS, `venues[${index}].count_gate`);
    const countGate: CountGate = {
      minimumAbsolute: plainInt(countRaw.minimum_absolute, "minimum_absolute", 1, 25_000),
      previousEditionMinRatio: ratio(
        countRaw.previous_edition_min_ratio,
        "previous_edition_min_ratio",
      ),
      previousEditionMaxRatio: ratio(
        countRaw.previous_edition_max_ratio,
        "previous_edition_max_ratio",
      ),
    };
    if (countGate.previousEditionMaxRatio < countGate.previousEditionMinRatio) {
      fail("previous edition maximum ratio must be >= minimum ratio");
    }

    const tracksRaw = closed(raw.tracks, TRACK_KEYS, `venues[${index}].tracks`);
    if (tracksRaw.accepted_only !== true) fail("v1 requires tracks.accepted_only=true");
    const acceptedLabels = labels(tracksRaw.accepted_decision_labels, "accepted_decision_labels");
    const highlightedLabels = labels(tracksRaw.highlighted_labels, "highlighted_labels");
    if (!highlightedLabels.every((l) => acceptedLabels.includes(l))) {
      fail("highlighted labels must be accepted decision labels");
    }

    const monthsRaw = raw.active_months_utc;
    if (!Array.isArray(monthsRaw) || monthsRaw.length === 0)
      fail("active_months_utc must be a non-empty array");
    const months = monthsRaw.map((m) => plainInt(m, "active month", 1, 12));
    if (new Set(months).size !== months.length)
      fail("active_months_utc must not contain duplicates");

    const displayTemplate = str(raw.display_template, "display_template");
    const slugTemplate = str(raw.slug_template, "slug_template");
    const sourceTemplate = str(raw.source_id_template, "source_id_template");
    const sampleYear = 2000;
    expandYearTemplate(displayTemplate, sampleYear, "display_template");
    const sampleSlug = expandYearTemplate(slugTemplate, sampleYear, "slug_template");
    const sampleSourceId = expandYearTemplate(sourceTemplate, sampleYear, "source_id_template");
    if (!SLUG_RE.test(sampleSlug) || sampleSlug === "daily") {
      fail(`expanded slug is invalid: ${JSON.stringify(sampleSlug)}`);
    }
    if (!SOURCE_ID_RE.test(sampleSourceId)) {
      fail(`expanded OpenReview source_id is invalid: ${JSON.stringify(sampleSourceId)}`);
    }

    const tracks: TrackPolicy = {
      acceptedOnly: true,
      acceptedDecisionLabels: acceptedLabels,
      highlightedLabels,
    };
    venues.push({
      venueKey: key,
      enabled: raw.enabled,
      curatedClass: "top",
      displayTemplate,
      slugTemplate,
      adapter: SUPPORTED_ADAPTER,
      sourceIdTemplate: sourceTemplate,
      firstYear: plainInt(raw.first_year, "first_year", 2000, 2100),
      activeMonthsUtc: months,
      countGate,
      tracks,
    });
  });

  const registry = {
    schemaVersion: SCHEMA_VERSION,
    applyEnabled: root.apply_enabled,
    defaults,
    venues,
  };
  // Final shape re-check via the zod schema (belt-and-suspenders: every
  // field above was already individually validated, but this also locks
  // in the object's exact key set/types the same way the Python
  // dataclasses do by construction).
  return ConferenceRegistrySchema.parse(registry);
}

/** Load a YAML registry while rejecting duplicate keys and unsafe shapes — TS port of `load_registry`. */
export function loadRegistryText(text: string): ConferenceRegistry {
  if (Buffer.byteLength(text, "utf-8") > MAX_REGISTRY_BYTES) {
    fail("conference registry exceeds the 64 KiB limit");
  }
  let raw: unknown;
  try {
    // `merge: false`: Python's loader overrides the mapping constructor
    // directly (bypassing PyYAML's `flatten_mapping` merge-key
    // preprocessing), so a YAML `<<:` merge key is never resolved there
    // either — it just becomes a literal `"<<"` key, which `closed()`
    // below then rejects as unknown. Disabling it here keeps the same
    // "merge keys are not a supported registry feature" behavior.
    raw = parseYaml(text, { uniqueKeys: true, merge: false } as never);
    validateStructure(raw);
  } catch (e) {
    if (e instanceof RegistryError) throw e;
    fail("unable to load conference registry");
  }
  return parseRegistry(raw);
}

function edition(
  registry: ConferenceRegistry,
  venue: Venue,
  year: number,
  currentYear: number,
): Edition {
  if (!(venue.firstYear <= year && year <= currentYear + registry.defaults.maxFutureYears)) {
    fail("edition year is outside the registry bound");
  }
  const slug = expandYearTemplate(venue.slugTemplate, year, "slug_template");
  if (!SLUG_RE.test(slug) || slug === "daily") fail("expanded edition slug is invalid");
  return {
    editionId: slug,
    venueKey: venue.venueKey,
    year,
    displayName: expandYearTemplate(venue.displayTemplate, year, "display_template"),
    adapter: venue.adapter,
    sourceId: expandYearTemplate(venue.sourceIdTemplate, year, "source_id_template"),
    countGate: venue.countGate,
    tracks: venue.tracks,
    stableMinSeparationHours: registry.defaults.stableMinSeparationHours,
    stableMaxSeparationHours: registry.defaults.stableMaxSeparationHours,
  };
}

/** @internal exported for `baseline.ts`'s revalidation, mirrors Python's `_edition` import. */
export { edition as buildEdition };

/** Plan only enabled current/next-year editions in their active window — TS port of `plan_editions` (CNF-37). */
export function planEditions(registry: ConferenceRegistry, now: Date): Edition[] {
  // `now` must be an explicit instant (TS `Date` has no naive/aware
  // distinction the way Python's `datetime` does — see models.ts's
  // `publicValue` doc comment for the same pycompat gap elsewhere). This
  // port therefore requires the caller to always pass a real `Date` and
  // treats it as already a correct instant; the "timezone-aware" input
  // gate the Python version enforces on a naive `datetime` has no TS
  // equivalent to reject, so there is nothing further to check here.
  const utcNow = now;
  const upperYear = utcNow.getUTCFullYear() + registry.defaults.maxFutureYears;
  const editions: Edition[] = [];
  for (const venue of registry.venues) {
    if (!venue.enabled) continue;
    if (!venue.activeMonthsUtc.includes(utcNow.getUTCMonth() + 1)) continue;
    for (let year = Math.max(venue.firstYear, utcNow.getUTCFullYear()); year <= upperYear; year++) {
      editions.push(edition(registry, venue, year, utcNow.getUTCFullYear()));
    }
  }
  return editions.sort((a, b) =>
    a.editionId < b.editionId ? -1 : a.editionId > b.editionId ? 1 : 0,
  );
}
