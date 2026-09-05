import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const inventories = Object.freeze([
  Object.freeze({
    directory: join(process.cwd(), "worker"),
    accepts: (name) => name.endsWith(".test.mjs"),
  }),
  Object.freeze({
    directory: join(process.cwd(), "paperpilot", "tests", "viewer"),
    accepts: (name) => name.startsWith("test_") && name.endsWith(".mjs"),
  }),
]);

const suites = inventories.flatMap(({ directory, accepts }) =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && accepts(entry.name))
    .map((entry) => join(directory, entry.name)),
).sort();

assert.ok(suites.length > 0, "expected at least one Node test suite");
assert.equal(new Set(suites).size, suites.length, "Node test inventory must be unique");

const result = spawnSync(process.execPath, ["--test", ...suites], {
  cwd: process.cwd(),
  env: Object.freeze({ HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin" }),
  shell: false,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
