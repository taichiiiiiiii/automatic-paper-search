/**
 * P2 review LOW-5: `app/[conf]/lineage/layout.tsx`'s
 * `listConferencesWithLineageData` used to swallow a `readFile`
 * failure for `public/<conf>/lineage.json` into `null` ("this
 * conference has no lineage data"), the same fallback used for
 * genuinely malformed JSON. But `conf` here always comes from
 * `listConferenceSlugsWithFile("lineage.json")`, which already
 * confirmed (via `stat`) that the file exists -- a `readFile` failure
 * for a slug it just found means `public/<conf>/lineage.json` is
 * missing/unreadable despite `docs/<conf>/lineage.json` existing (the
 * `prebuild` copy step from `docs/` to `public/` did not run, failed,
 * or raced), a build-environment inconsistency that must fail the
 * build loudly, not silently drop the route -- same principle as
 * `lib/lineage/server-fs.ts`'s own `readdir` failure
 * (test/lineage/server-fs-readdir-failure.test.ts).
 *
 * Only `readFile` is mocked; `readdir`/`stat` stay real so
 * `listConferenceSlugsWithFile("lineage.json")` finds the REAL
 * `docs/*\/lineage.json` candidates (today: all 10 conferences), which
 * is what makes `readFile` actually get called here.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: vi.fn(async () => {
      throw new Error("EACCES: permission denied, open 'public/iclr-2026/lineage.json'");
    }),
  };
});

describe("listConferencesWithLineageData: readFile failure", () => {
  it("rejects instead of silently dropping the route", async () => {
    const { listConferencesWithLineageData } = await import("../../app/[conf]/lineage/layout");
    await expect(listConferencesWithLineageData()).rejects.toThrow(/EACCES/);
  });
});
