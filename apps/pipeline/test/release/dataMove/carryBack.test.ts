/**
 * `carryBack` (p5-plan.md §5.2/§6.2 R-B step 4, review finding M3): the
 * standalone "carry every post-B data/** change back to its legacy path"
 * mode `apply --reverse` cannot provide on its own (it only ever touches
 * paths that existed in its `beforeRef`'s own plan).
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { apply } from "../../../src/release/dataMove/apply.js";
import {
  CarryBackError,
  type CarryBackManifest,
  carryBack,
  reverseMapDataPath,
} from "../../../src/release/dataMove/carryBack.js";
import {
  adapter,
  buildFixtureRepo,
  CONFIG_YAML_FIXTURE,
  cleanupFixtureRepo,
  type FixtureRepo,
  gitRun,
} from "./fixtures.js";

let fixture: FixtureRepo | undefined;

afterEach(() => {
  if (fixture) cleanupFixtureRepo(fixture);
  fixture = undefined;
});

function applyAndCommitCutover(repo: string): string {
  apply({ git: adapter, cwd: repo, confirmDelete: "docs/daily/papers.json" });
  gitRun(repo, ["commit", "-m", "data(p5): cutover"]);
  return gitRun(repo, ["rev-parse", "HEAD"]);
}

describe("reverseMapDataPath", () => {
  it("maps a brand-new conference's published file back to docs/<conf>/<basename>", () => {
    const entry = reverseMapDataPath("data/published/neurips-2027/papers.json");
    expect(entry).toBeDefined();
    expect(entry?.path).toBe("docs/neurips-2027/papers.json");
    expect(entry?.dest).toBe("data/published/neurips-2027/papers.json");
  }, 20_000);

  it("maps a brand-new theme's lineage.json back to docs/themes/<slug>/lineage.json", () => {
    const entry = reverseMapDataPath("data/published/themes/mixture-of-depths/lineage.json");
    expect(entry?.path).toBe("docs/themes/mixture-of-depths/lineage.json");
  }, 20_000);

  it("maps a state file back to paperpilot/data/<name>", () => {
    const entry = reverseMapDataPath("data/state/seen_ids.json");
    expect(entry?.path).toBe("paperpilot/data/seen_ids.json");
  }, 20_000);

  it("maps a lineage-cache entry back to paperpilot/data/lineage-cache/<name>", () => {
    const entry = reverseMapDataPath("data/state/lineage-cache/classifications.json");
    expect(entry?.path).toBe("paperpilot/data/lineage-cache/classifications.json");
  }, 20_000);

  it("maps an inputs file back to paperpilot/output/<rest>", () => {
    const entry = reverseMapDataPath("data/inputs/daily/papers_2026-10-05.csv");
    expect(entry?.path).toBe("paperpilot/output/daily/papers_2026-10-05.csv");
  }, 20_000);

  it("maps config.yaml back as a moveEdit entry (with its edits intact)", () => {
    const entry = reverseMapDataPath("data/config/config.yaml");
    expect(entry?.path).toBe("paperpilot/config.yaml");
    expect(entry?.class).toBe("moveEdit");
  }, 20_000);

  it("refuses (returns undefined) for a p5-only path with no legacy equivalent", () => {
    // conference-copy/<slug>.json is new in p5 (plan §2 A2) — never existed
    // under paperpilot/data, so there is nothing to carry it back to.
    expect(reverseMapDataPath("data/config/conference-copy/cvpr-2027.json")).toBeUndefined();
  }, 20_000);

  it("RED/GREEN: is injective — a p5 path whose legacy candidate maps elsewhere is refused (round-trip dest check)", () => {
    // paperpilot/data/seen_ids.json forward-maps to data/state/seen_ids.json,
    // so data/config/seen_ids.json must not be "carried back" onto it too.
    expect(reverseMapDataPath("data/config/seen_ids.json")).toBeUndefined();
    // ...and the reverse: lineage_denylist.json lives in data/config, not data/state.
    expect(reverseMapDataPath("data/state/lineage_denylist.json")).toBeUndefined();
    expect(reverseMapDataPath("data/config/lineage_denylist.json")?.path).toBe(
      "paperpilot/data/lineage_denylist.json",
    );
  }, 20_000);

  it("returns undefined for a path outside every data/ root", () => {
    expect(reverseMapDataPath("apps/web/README.md")).toBeUndefined();
  }, 20_000);
});

describe("carryBack", () => {
  it("RED/GREEN: carries a brand-new post-B theme file back to its legacy path", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);

    const themeDir = join(repo, "data/published/themes/mixture-of-depths");
    mkdirSync(themeDir, { recursive: true });
    writeFileSync(join(themeDir, "lineage.json"), '{"nodes":["new"]}\n');
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "theme-on-demand: mixture-of-depths"]);

    const result = carryBack({ git: adapter, cwd: repo, since: cutoverSha });
    expect(result.entries).toEqual([
      {
        p5Path: "data/published/themes/mixture-of-depths/lineage.json",
        legacyPath: "docs/themes/mixture-of-depths/lineage.json",
        status: "A",
      },
    ]);
    expect(readFileSync(join(repo, "docs/themes/mixture-of-depths/lineage.json"), "utf-8")).toBe(
      '{"nodes":["new"]}\n',
    );
    // Staged, not committed.
    expect(gitRun(repo, ["status", "--porcelain", "--", "docs/"])).toContain(
      "docs/themes/mixture-of-depths/lineage.json",
    );
  }, 20_000);

  it("carries a post-B modification of a pre-existing published file", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);

    const papersPath = join(repo, "data/published/cvpr-2026/papers.json");
    writeFileSync(papersPath, '{"papers":["updated"]}\n');
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "weekly: refresh cvpr-2026"]);

    const result = carryBack({ git: adapter, cwd: repo, since: cutoverSha });
    expect(result.entries).toEqual([
      {
        p5Path: "data/published/cvpr-2026/papers.json",
        legacyPath: "docs/cvpr-2026/papers.json",
        status: "M",
      },
    ]);
    expect(readFileSync(join(repo, "docs/cvpr-2026/papers.json"), "utf-8")).toBe(
      '{"papers":["updated"]}\n',
    );
  }, 20_000);

  it("carries a post-B deletion as a no-op when the legacy path is already absent (--ignore-unmatch)", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);

    gitRun(repo, ["rm", "data/published/cvpr-2026/papers.json"]);
    gitRun(repo, ["commit", "-m", "weekly: drop cvpr-2026 (shrink)"]);

    const result = carryBack({ git: adapter, cwd: repo, since: cutoverSha });
    expect(result.entries).toEqual([
      {
        p5Path: "data/published/cvpr-2026/papers.json",
        legacyPath: "docs/cvpr-2026/papers.json",
        status: "D",
      },
    ]);
    expect(existsSync(join(repo, "docs/cvpr-2026/papers.json"))).toBe(false);
  }, 20_000);

  it("RED/GREEN: refuses the whole call when a changed path has no legacy equivalent", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);

    const copyDir = join(repo, "data/config/conference-copy");
    mkdirSync(copyDir, { recursive: true });
    writeFileSync(join(copyDir, "cvpr-2027.json"), '{"display":"CVPR 2027"}\n');
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-m", "conference-on-demand: cvpr-2027 scaffold copy"]);

    expect(() => carryBack({ git: adapter, cwd: repo, since: cutoverSha })).toThrow(CarryBackError);
    expect(() => carryBack({ git: adapter, cwd: repo, since: cutoverSha })).toThrow(
      /no legacy-path equivalent/,
    );
    // Nothing staged by the refused attempt.
    expect(gitRun(repo, ["status", "--porcelain", "--", "docs/", "paperpilot/"])).toBe("");
  }, 20_000);

  it("is a no-op (empty entries) when nothing under data/ changed since the given ref", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);

    const result = carryBack({ git: adapter, cwd: repo, since: cutoverSha });
    expect(result.entries).toEqual([]);
  }, 20_000);

  it("RED/GREEN: reverses the moveEdit config edits (legacy paths, not p5 paths) on a post-B config change", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    const p5Config = join(repo, "data/config/config.yaml");
    writeFileSync(
      p5Config,
      readFileSync(p5Config, "utf-8").replace("max_age_days: 14", "max_age_days: 30"),
    );
    gitRun(repo, ["commit", "-q", "-am", "post-B: config tweak"]);

    carryBack({ git: adapter, cwd: repo, since: cutoverSha });
    expect(readFileSync(join(repo, "paperpilot/config.yaml"), "utf-8")).toBe(
      CONFIG_YAML_FIXTURE.replace("max_age_days: 14", "max_age_days: 30"),
    );
  }, 20_000);

  it("RED/GREEN: refuses a typechange (status T) instead of flattening it; nothing staged", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    gitRun(repo, ["rm", "-q", "data/state/seen_ids.json"]);
    symlinkSync("../published/conferences.json", join(repo, "data/state/seen_ids.json"));
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-q", "-m", "post-B: typechange"]);

    expect(() => carryBack({ git: adapter, cwd: repo, since: cutoverSha })).toThrow(/"T"/);
    expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
  }, 20_000);

  it("refuses an added symlink (mode 120000) instead of flattening it", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    symlinkSync("classifications.json", join(repo, "data/state/lineage-cache/link.json"));
    // lineage-cache/* is gitignored (only classifications.json is unignored); force-add like the real cache files.
    gitRun(repo, ["add", "-f", "data/state/lineage-cache/link.json"]);
    gitRun(repo, ["commit", "-q", "-m", "post-B: symlink"]);

    expect(() => carryBack({ git: adapter, cwd: repo, since: cutoverSha })).toThrow(
      /mode 120000 is not a plain file/,
    );
    expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
  }, 20_000);

  it("RED/GREEN: a post-B rename inside data/ is carried back as delete + add (--no-renames)", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    mkdirSync(join(repo, "data/published/themes/flash-attn"), { recursive: true });
    gitRun(repo, [
      "mv",
      "data/published/themes/flash-attention/lineage.json",
      "data/published/themes/flash-attn/lineage.json",
    ]);
    gitRun(repo, ["commit", "-q", "-m", "post-B: rename theme"]);

    const result = carryBack({ git: adapter, cwd: repo, since: cutoverSha });
    expect(result.entries.map((e) => `${e.status} ${e.legacyPath}`).sort()).toEqual([
      "A docs/themes/flash-attn/lineage.json",
      "D docs/themes/flash-attention/lineage.json",
    ]);
    expect(readFileSync(join(repo, "docs/themes/flash-attn/lineage.json"), "utf-8")).toBe(
      '{"nodes":[]}\n',
    );
  }, 20_000);

  it("RED/GREEN: carries a non-ASCII path byte-exactly (-z, no C-quoting)", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    mkdirSync(join(repo, "data/published/themes/café"), { recursive: true });
    writeFileSync(join(repo, "data/published/themes/café/lineage.json"), '{"nodes":["é"]}\n');
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-q", "-m", "post-B: café"]);

    const result = carryBack({ git: adapter, cwd: repo, since: cutoverSha });
    expect(result.entries).toEqual([
      {
        p5Path: "data/published/themes/café/lineage.json",
        legacyPath: "docs/themes/café/lineage.json",
        status: "A",
      },
    ]);
    expect(readFileSync(join(repo, "docs/themes/café/lineage.json"), "utf-8")).toBe(
      '{"nodes":["é"]}\n',
    );
  }, 20_000);

  it("RED/GREEN: carries the executable bit (index mode and worktree)", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    writeFileSync(join(repo, "data/inputs/daily/run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(repo, "data/inputs/daily/run.sh"), 0o755);
    chmodSync(join(repo, "data/inputs/cvpr-2026/summary.csv"), 0o755);
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-q", "-m", "post-B: executables"]);

    carryBack({ git: adapter, cwd: repo, since: cutoverSha });
    expect(gitRun(repo, ["ls-files", "-s", "paperpilot/output/daily/run.sh"])).toMatch(/^100755 /);
    // A mode-only change (M) on a pre-existing file carries too.
    expect(gitRun(repo, ["ls-files", "-s", "paperpilot/output/cvpr-2026/summary.csv"])).toMatch(
      /^100755 /,
    );
    // The worktree matches the index (nothing left unstaged).
    expect(gitRun(repo, ["diff", "--name-only"])).toBe("");
  }, 20_000);

  it("RED/GREEN: refuses a dirty worktree (an untracked file at a legacy path) and touches nothing", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    writeFileSync(join(repo, "data/state/seen_ids.json"), '{"changed":1}\n');
    gitRun(repo, ["commit", "-q", "-am", "post-B: seen ids"]);
    mkdirSync(join(repo, "paperpilot/data"), { recursive: true });
    writeFileSync(join(repo, "paperpilot/data/seen_ids.json"), "local scratch\n");

    expect(() => carryBack({ git: adapter, cwd: repo, since: cutoverSha })).toThrow(/not clean/);
    expect(readFileSync(join(repo, "paperpilot/data/seen_ids.json"), "utf-8")).toBe(
      "local scratch\n",
    );
    expect(gitRun(repo, ["diff", "--cached", "--name-only"])).toBe("");
  }, 20_000);

  it("RED/GREEN: carries a 755 mode on a moveEdit config (--chmod +x), index and worktree", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    const p5Config = join(repo, "data/config/config.yaml");
    writeFileSync(
      p5Config,
      readFileSync(p5Config, "utf-8").replace("max_age_days: 14", "max_age_days: 30"),
    );
    chmodSync(p5Config, 0o755);
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-q", "-m", "post-B: config tweak, now executable"]);

    carryBack({ git: adapter, cwd: repo, since: cutoverSha });
    expect(gitRun(repo, ["ls-files", "-s", "paperpilot/config.yaml"])).toMatch(/^100755 /);
    expect(gitRun(repo, ["diff", "--name-only"])).toBe("");
  }, 20_000);

  it("reports staged=false for a delete-only carry-back (M2: the commit must be --allow-empty)", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    gitRun(repo, ["rm", "-q", "data/published/themes/flash-attention/lineage.json"]);
    gitRun(repo, ["commit", "-q", "-m", "post-B: delete a theme"]);

    const result = carryBack({ git: adapter, cwd: repo, since: cutoverSha });
    expect(result.entries.map((e) => e.status)).toEqual(["D"]);
    expect(result.staged).toBe(false);
    expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
  }, 20_000);
});

describe("carryBack: atomic on late failures (review round 3, L3)", () => {
  /** The reviewer's r3rb4 shape: an added config file (sorts first) plus a post-B change to a moveEdit key. */
  function addConfigAndDriftLoggingKey(repo: string): void {
    writeFileSync(join(repo, "data/config/conference-sources-v1.yaml"), "sources: []\n");
    const p5Config = join(repo, "data/config/config.yaml");
    const text = readFileSync(p5Config, "utf-8");
    const drifted = text.replace("file: logs/paperpilot.log", "file: logs/paperpilot-weekly.log");
    expect(drifted).not.toBe(text);
    writeFileSync(p5Config, drifted);
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-q", "-m", "post-B: new config file + logging.file change"]);
  }

  it("RED/GREEN: a moveEdit key changed after B refuses the whole call; nothing staged, no manifest", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    addConfigAndDriftLoggingKey(repo);

    let written: CarryBackManifest | undefined;
    expect(() =>
      carryBack({
        git: adapter,
        cwd: repo,
        since: cutoverSha,
        writeManifest: (m) => {
          written = m;
        },
      }),
    ).toThrow(CarryBackError);
    expect(() => carryBack({ git: adapter, cwd: repo, since: cutoverSha })).toThrow(
      /data\/config\/config\.yaml: its moveEdit keys cannot be reversed/,
    );
    expect(written).toBeUndefined();
    expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, "paperpilot/data/conference-sources-v1.yaml"))).toBe(false);
  }, 20_000);

  it("RED/GREEN: an unwritable manifest refuses before anything is staged", () => {
    fixture = buildFixtureRepo();
    const repo = fixture.repo;
    const cutoverSha = applyAndCommitCutover(repo);
    writeFileSync(join(repo, "data/config/conference-sources-v1.yaml"), "sources: []\n");
    writeFileSync(join(repo, "data/state/seen_ids.json"), '{"x":1}\n');
    gitRun(repo, ["add", "-A"]);
    gitRun(repo, ["commit", "-q", "-m", "post-B: two data changes"]);

    expect(() =>
      carryBack({
        git: adapter,
        cwd: repo,
        since: cutoverSha,
        writeManifest: () => {
          throw new Error("EACCES: permission denied, open '/carry-back.json'");
        },
      }),
    ).toThrow(/cannot write the manifest[\s\S]*nothing was staged/);
    expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
  }, 20_000);

  describe("real tsx spawn", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..", "..", "..");
    const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
    const cli = join(repoRoot, "apps", "pipeline", "src", "release", "dataMove", "cli.ts");

    function run(repo: string, args: string[]) {
      return spawnSync(tsx, [cli, ...args], { cwd: repo, encoding: "utf-8" });
    }

    it("RED/GREEN: --manifest into a missing directory exits 1 with the index untouched", () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const cutoverSha = applyAndCommitCutover(repo);
      writeFileSync(join(repo, "data/config/conference-sources-v1.yaml"), "sources: []\n");
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: new config file"]);

      const missing = join(fixture.base, "no-such-dir", "carry-back.json");
      const result = run(repo, ["carry-back", "--since", cutoverSha, "--manifest", missing]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/cannot write the manifest/);
      expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
    }, 30_000);

    it("RED/GREEN: carry-back without --manifest (or with an empty one) is refused", () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const cutoverSha = applyAndCommitCutover(repo);
      writeFileSync(join(repo, "data/state/seen_ids.json"), '{"x":1}\n');
      gitRun(repo, ["commit", "-q", "-am", "post-B: seen ids"]);

      for (const extra of [[], ["--manifest", ""]]) {
        const result = run(repo, ["carry-back", "--since", cutoverSha, ...extra]);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/requires --manifest/);
      }
      expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
    }, 30_000);

    it("prints the --allow-empty instruction when nothing is staged (M2)", () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const cutoverSha = applyAndCommitCutover(repo);
      gitRun(repo, ["rm", "-q", "data/published/themes/flash-attention/lineage.json"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: delete a theme"]);
      const manifestPath = join(fixture.base, "carry-back.json");

      const result = run(repo, ["carry-back", "--since", cutoverSha, "--manifest", manifestPath]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/git commit --no-verify --allow-empty/);
      expect(JSON.parse(readFileSync(manifestPath, "utf-8")).entries).toHaveLength(1);
    }, 30_000);
  });
});
