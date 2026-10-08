/**
 * Port of `paperpilot/tests/test_utils_atomic.py` (the `atomic_write_*`
 * cases; `versioned_cache` is P4a-tagged in safety-contracts.md but backs
 * only the P4d lineage/theme caches — out of this task's collect/signals/
 * exporters/stages/runner/CLI scope, so not ported here).
 */

import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWriteBytes, atomicWriteText } from "../../../src/collect/state/atomic.js";

// `node:fs`'s native namespace is not configurable, so `vi.spyOn` cannot
// redefine a property on it directly. Replacing the module with a plain
// (spread) object via `vi.mock` makes every export a configurable,
// writable property — the standard Vitest way to monkeypatch a builtin,
// and the equivalent of Python's `monkeypatch.setattr(atomic_module.os,
// "replace", ...)` seam.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("test_atomic_write_replaces_content_and_leaves_no_temp", () => {
  const out = join(dir, "sub", "a.json");
  atomicWriteText(out, "one");
  atomicWriteText(out, "two");
  expect(readFileSync(out, "utf-8")).toBe("two");
  expect(readdirSync(join(dir, "sub"))).toEqual(["a.json"]);
});

it("test_failed_replace_keeps_the_old_file_and_cleans_up", () => {
  const out = join(dir, "a.json");
  writeFileSync(out, "previous");
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("disk full");
  });
  expect(() => atomicWriteText(out, "new")).toThrow("disk full");
  expect(readFileSync(out, "utf-8")).toBe("previous");
  expect(readdirSync(dir)).toEqual(["a.json"]);
});

it("test_each_write_uses_a_distinct_temporary_name", () => {
  const sources: string[] = [];
  const real = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation(
    (src: Parameters<typeof real>[0], dst: Parameters<typeof real>[1]) => {
      sources.push(String(src));
      return real(src, dst);
    },
  );
  const out = join(dir, "a.json");
  atomicWriteText(out, "1");
  atomicWriteText(out, "2");
  expect(new Set(sources).size).toBe(2);
});

it("test_new_file_is_world_readable_and_existing_mode_is_kept", () => {
  const fresh = join(dir, "fresh.json");
  atomicWriteText(fresh, "x");
  expect(statSync(fresh).mode & 0o777).toBe(0o644);

  const priv = join(dir, "private.json");
  writeFileSync(priv, "x", { mode: 0o600 });
  atomicWriteText(priv, "y");
  expect(statSync(priv).mode & 0o777).toBe(0o600);
});

it("test_short_write_is_retried_until_the_full_payload_is_written (M1)", () => {
  // Simulate `fs.writeSync` writing at most 3 bytes per call, the way a
  // real partial `write(2)` can — without throwing, so the only defense is
  // checking (and looping on) the return value.
  const out = join(dir, "a.json");
  const real = fs.writeSync;
  const shortWriteImpl = ((
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset?: number,
    length?: number,
  ) => {
    const off = offset ?? 0;
    const total = length ?? (buffer as Buffer).length - off;
    const capped = Math.min(3, total);
    return real(fd, buffer as Buffer, off, capped);
  }) as typeof fs.writeSync;
  vi.spyOn(fs, "writeSync").mockImplementation(shortWriteImpl);
  const payload = "0123456789abcdef"; // forces several short writes
  atomicWriteText(out, payload);
  expect(readFileSync(out, "utf-8")).toBe(payload);
});

it("test_atomic_write_bytes_round_trips", () => {
  const out = join(dir, "a.bin");
  atomicWriteBytes(out, Buffer.from([0x00, 0x01]));
  expect(readFileSync(out)).toEqual(Buffer.from([0x00, 0x01]));
});

describe("utf-8-sig", () => {
  it("prepends a BOM", () => {
    const out = join(dir, "a.csv");
    atomicWriteText(out, "rank,title\r\n", { encoding: "utf-8-sig" });
    const raw = readFileSync(out);
    expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});
