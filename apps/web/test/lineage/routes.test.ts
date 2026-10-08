/**
 * Shape checks against the built static export (same pattern as
 * test/csp.test.ts): every lineage/deep route must exist at its
 * extensionless, trailing-slash path, and its initial (pre-hydration)
 * HTML must not expose any interactive control before the client-side
 * quality-manifest gate has run -- the React analogue of
 * paperpilot/tests/viewer/test_lineage_focus_route.py's
 * `test_focus_route_is_static_fail_closed` and
 * `test_direct_routes_expose_no_controls_before_audit_passes`.
 *
 * Requires `next build` (output: "export") to have run first -- see
 * test/csp.test.ts's identical requirement. If `apps/web/out` does not
 * exist, this suite throws in `beforeAll` with instructions, same as
 * that file.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(TEST_DIR, "..", "..", "out");

beforeAll(async () => {
  try {
    await stat(OUT_DIR);
  } catch {
    throw new Error(
      `${OUT_DIR} does not exist. Run "next build" (output: export) before "vitest run".`,
    );
  }
});

async function readRoute(routePath: string): Promise<string> {
  return readFile(join(OUT_DIR, routePath, "index.html"), "utf8");
}

// No interactive control -- button, select, input, or an href into the
// ready-only data flow -- may appear before the client has verified the
// quality manifest. The loading state renders only the audit-status
// section (see components/lineage/audit-status.tsx).
function assertNoControlsExposed(html: string, routeLabel: string): void {
  expect(html, `${routeLabel}: unexpected <button>`).not.toMatch(/<button\b/);
  expect(html, `${routeLabel}: unexpected <select>`).not.toMatch(/<select\b/);
  expect(html, `${routeLabel}: unexpected <input\b[^>]*type="search"/`).not.toMatch(
    /<input\b[^>]*type="search"/,
  );
  expect(html, `${routeLabel}: carries the loading copy`).toContain(
    "公開索引と監査情報の一致を確認しています。",
  );
}

describe("conference lineage route (/[conf]/lineage/)", () => {
  it("builds for iclr-2026 and exposes no controls before the gate resolves", async () => {
    const html = await readRoute("iclr-2026/lineage");
    assertNoControlsExposed(html, "iclr-2026/lineage");
    expect(html).toContain('id="main-content"');
  });
});

describe("conference deep route (/[conf]/deep/)", () => {
  it("builds for iclr-2026 (the only conference with a deep-manifest.json)", async () => {
    const html = await readRoute("iclr-2026/deep");
    assertNoControlsExposed(html, "iclr-2026/deep");
  });
});

describe("Focus View route (/lineage/)", () => {
  it("builds and exposes no controls before the gate resolves", async () => {
    const html = await readRoute("lineage");
    assertNoControlsExposed(html, "lineage");
    expect(html).toContain("AUDITED LINEAGE / FOCUS VIEW");
  });
});
