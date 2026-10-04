import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRules, rulesForFile, toIgnoreSegments } from "../../src/parity/rules.js";

describe("rules", () => {
  it("rulesForFile returns every matching glob's pointers, in order", () => {
    const rules = {
      ignore: [
        { glob: "*.json", pointers: ["/generated_at"] },
        { glob: "manifest.json", pointers: ["/meta/build_id"] },
        { glob: "other.json", pointers: ["/unused"] },
      ],
    };
    const matched = rulesForFile(rules, "manifest.json");
    expect(matched).toEqual([
      { glob: "*.json", pointers: ["/generated_at"] },
      { glob: "manifest.json", pointers: ["/meta/build_id"] },
    ]);
  });

  it("toIgnoreSegments parses every pointer into segments", () => {
    const segments = toIgnoreSegments([{ glob: "*.json", pointers: ["/a/b", "/c"] }]);
    expect(segments).toEqual([["a", "b"], ["c"]]);
  });

  it("loadRules returns {} when no file path is given", async () => {
    expect(await loadRules(undefined)).toEqual({});
  });

  describe("loadRules from a file", () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), "parity-rules-"));
    });

    afterEach(async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it("parses a valid rules file", async () => {
      const file = path.join(tmp, "rules.json");
      await fs.writeFile(
        file,
        JSON.stringify({ ignore: [{ glob: "*.json", pointers: ["/generated_at"] }] }),
      );
      const rules = await loadRules(file);
      expect(rules).toEqual({ ignore: [{ glob: "*.json", pointers: ["/generated_at"] }] });
    });

    it("rejects a rules file that is not the expected shape", async () => {
      const file = path.join(tmp, "bad.json");
      await fs.writeFile(file, JSON.stringify({ ignore: [{ glob: "*.json" }] }));
      await expect(loadRules(file)).rejects.toThrow();
    });

    it("rejects a rules file that is not valid JSON", async () => {
      const file = path.join(tmp, "bad.json");
      await fs.writeFile(file, "{not json");
      await expect(loadRules(file)).rejects.toThrow();
    });
  });
});
