/**
 * ACL CLI entry point (LOW of the P4 review: "ACL has no CLI entry
 * point"). `isMain()` is this file's own LOCAL guard (the shared
 * `isMain()` helper that will replace it, per M2, is a separate later
 * task) — it compares `realpathSync` of `import.meta.url` and
 * `process.argv[1]` instead of the naive `import.meta.url ===
 * file://${argv[1]}` string comparison other lineage CLIs use, which
 * breaks on a symlinked / space-containing / non-ASCII invocation path.
 */
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isMain } from "../../../src/conference/acl/cli.js";

const THIS_CLI_SOURCE_FILE = fileURLToPath(
  new URL("../../../src/conference/acl/cli.ts", import.meta.url),
);

const originalArgv1: string | undefined = process.argv[1];
afterEach(() => {
  process.argv[1] = originalArgv1 as string;
});

describe("isMain (ACL CLI entry point)", () => {
  it("is false when argv[1] is undefined (module only imported, e.g. by a test)", () => {
    process.argv[1] = undefined as unknown as string;
    expect(isMain()).toBe(false);
  });

  it("is false when argv[1] names an unrelated file (this process's real entry, e.g. vitest)", () => {
    // Whatever the real test runner's argv[1] already is (not this
    // module), importing this file in a test must never behave as "main".
    expect(originalArgv1).toBeDefined();
    expect(originalArgv1).not.toBe(THIS_CLI_SOURCE_FILE);
    process.argv[1] = originalArgv1 as string;
    expect(isMain()).toBe(false);
  });

  it("is false when argv[1] points to a nonexistent path", () => {
    process.argv[1] = "/nonexistent/path/that/does/not/exist.ts";
    expect(isMain()).toBe(false);
  });

  it("is true when argv[1] is this file's own compiled/source path", () => {
    process.argv[1] = THIS_CLI_SOURCE_FILE;
    expect(isMain()).toBe(true);
  });

  it("is true when argv[1] is a SYMLINK to this file (the bug a bare file://argv[1] string compare has)", () => {
    const dir = mkdtempSync(join(tmpdir(), "acl-cli-isMain-"));
    const link = join(dir, "cli-invoked-via-symlink.ts");
    symlinkSync(THIS_CLI_SOURCE_FILE, link);
    process.argv[1] = link;
    expect(isMain()).toBe(true);
  });
});
