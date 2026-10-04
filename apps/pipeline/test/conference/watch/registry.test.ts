/**
 * Port of `paperpilot/tests/test_conference_watch_registry.py` (CNF-26/37,
 * docs/migration/safety-contracts.md).
 */
import { describe, expect, it } from "vitest";
import { RegistryError } from "../../../src/conference/watch/models.js";
import {
  loadRegistryText,
  parseRegistry,
  planEditions,
} from "../../../src/conference/watch/registry.js";

function validRegistryObject(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schema_version: "conference-sources-v1",
    apply_enabled: true,
    defaults: {
      probe_interval_hours: 6,
      stable_min_separation_hours: 12,
      stable_max_separation_hours: 72,
      max_future_years: 1,
    },
    venues: [
      {
        venue_key: "iclr",
        enabled: true,
        curated_class: "top",
        display_template: "ICLR {year}",
        slug_template: "iclr-{year}",
        adapter: "openreview-v2",
        source_id_template: "ICLR.cc/{year}/Conference",
        first_year: 2024,
        active_months_utc: [1, 2, 3],
        count_gate: {
          minimum_absolute: 100,
          previous_edition_min_ratio: 0.5,
          previous_edition_max_ratio: 2.0,
        },
        tracks: {
          accepted_only: true,
          accepted_decision_labels: ["accept", "reject"],
          highlighted_labels: ["accept"],
        },
      },
    ],
    ...overrides,
  };
}

function validRegistryYaml(): string {
  return `
schema_version: conference-sources-v1
apply_enabled: true
defaults:
  probe_interval_hours: 6
  stable_min_separation_hours: 12
  stable_max_separation_hours: 72
  max_future_years: 1
venues:
  - venue_key: iclr
    enabled: true
    curated_class: top
    display_template: "ICLR {year}"
    slug_template: "iclr-{year}"
    adapter: openreview-v2
    source_id_template: "ICLR.cc/{year}/Conference"
    first_year: 2024
    active_months_utc: [1, 2, 3]
    count_gate:
      minimum_absolute: 100
      previous_edition_min_ratio: 0.5
      previous_edition_max_ratio: 2.0
    tracks:
      accepted_only: true
      accepted_decision_labels: [accept, reject]
      highlighted_labels: [accept]
`;
}

describe("parseRegistry", () => {
  it("parses a valid registry", () => {
    const registry = parseRegistry(validRegistryObject());
    expect(registry.venues).toHaveLength(1);
    expect(registry.venues[0]?.venueKey).toBe("iclr");
  });

  it("CNF-26: rejects an unknown top-level key (not closed)", () => {
    expect(() => parseRegistry({ ...validRegistryObject(), extra: 1 })).toThrow(RegistryError);
  });

  it("CNF-26: rejects a configurable probe count / unknown venue key", () => {
    const obj = validRegistryObject();
    (obj.venues as Record<string, unknown>[])[0]!.extra_field = 1;
    expect(() => parseRegistry(obj)).toThrow(RegistryError);
  });

  it("CNF-26: rejects duplicate venue_key", () => {
    const obj = validRegistryObject();
    const venues = obj.venues as Record<string, unknown>[];
    obj.venues = [venues[0]!, { ...venues[0] }];
    expect(() => parseRegistry(obj)).toThrow(RegistryError);
  });

  it("CNF-26: rejects scope widening (unsupported adapter)", () => {
    const obj = validRegistryObject();
    (obj.venues as Record<string, unknown>[])[0]!.adapter = "some-other-adapter";
    expect(() => parseRegistry(obj)).toThrow(RegistryError);
  });

  it("rejects an invalid slug template (bad template token)", () => {
    const obj = validRegistryObject();
    (obj.venues as Record<string, unknown>[])[0]!.slug_template = "iclr-{year}-{year}";
    expect(() => parseRegistry(obj)).toThrow(RegistryError);
  });
});

describe("loadRegistryText", () => {
  it("loads a valid YAML registry", () => {
    const registry = loadRegistryText(validRegistryYaml());
    expect(registry.venues[0]?.venueKey).toBe("iclr");
  });

  it("CNF-26: rejects duplicate YAML keys", () => {
    const yaml = `${validRegistryYaml()}\napply_enabled: false\n`;
    expect(() => loadRegistryText(yaml)).toThrow(RegistryError);
  });

  it("CNF-26: rejects an oversized registry (> 64 KiB)", () => {
    const huge = `${validRegistryYaml()}\n# ${"x".repeat(70_000)}\n`;
    expect(() => loadRegistryText(huge)).toThrow(RegistryError);
  });

  it("CNF-26: rejects a recursive-alias YAML document", () => {
    const yaml = `
a: &anchor
  b: *anchor
`;
    expect(() => loadRegistryText(yaml)).toThrow(RegistryError);
  });
});

describe("planEditions (CNF-37)", () => {
  it("plans only enabled editions within the active window", () => {
    const registry = parseRegistry(validRegistryObject());
    const now = new Date("2024-02-15T00:00:00Z");
    const editions = planEditions(registry, now);
    expect(editions.map((e) => e.editionId)).toEqual(["iclr-2024", "iclr-2025"]);
  });

  it("plans nothing outside the active months", () => {
    const registry = parseRegistry(validRegistryObject());
    const now = new Date("2024-07-01T00:00:00Z");
    expect(planEditions(registry, now)).toEqual([]);
  });

  it("plans nothing for a disabled venue", () => {
    const obj = validRegistryObject();
    (obj.venues as Record<string, unknown>[])[0]!.enabled = false;
    const registry = parseRegistry(obj);
    expect(planEditions(registry, new Date("2024-02-15T00:00:00Z"))).toEqual([]);
  });
});
