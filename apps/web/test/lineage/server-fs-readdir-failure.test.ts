/**
 * Separate file from test/lineage/server-fs.test.ts so `vi.mock`ing
 * `node:fs/promises` here cannot affect that file's unmocked,
 * real-docs/ tests (Vitest mocks are per test-file module graph, but
 * keeping these apart makes that isolation explicit rather than
 * incidental).
 *
 * P2 review LOW: see test/lineage/server-fs.test.ts's header for the
 * bug this pins -- a failed top-level `readdir(docs/)` must throw
 * (fail the build), not resolve to `[]`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => {
    throw new Error("ENOENT: no such file or directory, scandir 'docs'");
  }),
  stat: vi.fn(async () => {
    throw new Error("server-fs.ts must not reach per-file stat when readdir itself failed");
  }),
}));

describe("listConferenceSlugsWithFile: readdir failure", () => {
  it("rejects instead of resolving to an empty array", async () => {
    const { listConferenceSlugsWithFile } = await import("../../lib/lineage/server-fs");
    await expect(listConferenceSlugsWithFile("lineage.json")).rejects.toThrow(/ENOENT/);
  });
});
