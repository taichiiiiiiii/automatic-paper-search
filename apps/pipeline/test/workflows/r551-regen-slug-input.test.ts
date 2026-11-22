/**
 * #551 workflow contract: a `themes` input given as a published slug
 * ("neural-radiance-fields") must be rebuilt under the published display
 * name (`meta.theme`), not under the slug. Run 44949170383 passed the slug
 * and the manifest theme, `meta.theme`/`meta.keywords` and the quality
 * label all became the slug; the no-input regen then keeps reading it back.
 *
 * The guard loop sits between `# slug-input-guard: begin` / `end` markers in
 * the regen step; it is cut out and run with bash in a temp directory.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

const BEGIN = "# slug-input-guard: begin";
const END = "# slug-input-guard: end";

function regenStep(): YamlDoc {
  const doc = readWorkflow("regen-themes.yml");
  const gen = jobsOf(doc).find(([j]) => j === "generate");
  if (!gen) throw new Error("job generate not found");
  const s = (gen[1].steps as YamlDoc[]).find((x) => x.name === "Regenerate requested themes");
  if (!s) throw new Error("regen step not found");
  return s;
}
function regenRun(): string {
  return regenStep().run as string;
}

function guardSnippet(run: string): string {
  const b = run.indexOf(BEGIN);
  const e = run.indexOf(END);
  if (b < 0 || e < 0 || e < b) throw new Error("slug-input-guard markers not found");
  return run.slice(b, e);
}

/** Runs the guard on THEMES=(…) inside a repo-like temp dir. */
function runGuard(themes: string[]): { out: string[]; stdout: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "r551-"));
  const nerf = join(dir, "data/published/themes/neural-radiance-fields");
  mkdirSync(nerf, { recursive: true });
  writeFileSync(
    join(nerf, "lineage.json"),
    JSON.stringify({ meta: { theme: "Neural Radiance Fields", slug: "neural-radiance-fields" } }),
  );
  // A published theme whose meta.theme is already the slug: unchanged.
  const broken = join(dir, "data/published/themes/flash-attention");
  mkdirSync(broken, { recursive: true });
  writeFileSync(
    join(broken, "lineage.json"),
    JSON.stringify({ meta: { theme: "flash-attention", slug: "flash-attention" } }),
  );
  // A published theme without meta.theme: unchanged, no failure.
  const empty = join(dir, "data/published/themes/mixture-of-experts");
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, "lineage.json"), JSON.stringify({ meta: {} }));
  // A published meta.theme the regen loop's THEME_RE would reject: slug kept.
  const odd = join(dir, "data/published/themes/speculative-decoding");
  mkdirSync(odd, { recursive: true });
  writeFileSync(
    join(odd, "lineage.json"),
    JSON.stringify({ meta: { theme: "Speculative (decoding)" } }),
  );
  // A published meta.theme carrying a newline: never echoed, slug kept.
  const multi = join(dir, "data/published/themes/vision-transformer");
  mkdirSync(multi, { recursive: true });
  writeFileSync(
    join(multi, "lineage.json"),
    JSON.stringify({ meta: { theme: "Vision\n::error::x" } }),
  );
  const decl = `THEMES=(${themes.map((t) => `'${t.replace(/'/g, "'\\''")}'`).join(" ")})`;
  const script = `set -euo pipefail\n${decl}\n${guardSnippet(regenRun())}\nprintf '%s\\n' "\${THEMES[@]}"`;
  const r = spawnSync("bash", ["-c", script], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, THEME_RE: regenStep().env.THEME_RE as string },
  });
  rmSync(dir, { recursive: true, force: true });
  const lines = r.stdout.split("\n").filter((l) => l !== "");
  return {
    out: lines.filter((l) => !l.startsWith("::")),
    stdout: r.stdout,
    status: r.status,
  };
}

describe("#551 regen-themes: slug input -> published display name", () => {
  it("has the guard between the IFS split and the regen loop", () => {
    const run = regenRun();
    const split = run.indexOf("IFS=',' read -ra THEMES");
    const b = run.indexOf(BEGIN);
    const loop = run.indexOf('for raw_theme in "${THEMES[@]}"');
    expect(split).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(split);
    expect(loop).toBeGreaterThan(b);
  });

  it("uses only regex-checked values in the path and reads meta.theme with jq", () => {
    const g = guardSnippet(regenRun());
    expect(g).toContain("^[a-z0-9-]+$");
    expect(g).toContain("jq -r '.meta.theme // empty'");
    expect(g).not.toContain("${{");
  });

  it("replaces a published slug with its meta.theme and emits a notice", () => {
    const r = runGuard(["neural-radiance-fields"]);
    expect(r.status).toBe(0);
    expect(r.out).toEqual(["Neural Radiance Fields"]);
    expect(r.stdout).toMatch(/::notice::.*neural-radiance-fields.*Neural Radiance Fields/);
  });

  it("trims a slug entry before matching", () => {
    const r = runGuard(["  neural-radiance-fields "]);
    expect(r.status).toBe(0);
    expect(r.out).toEqual(["Neural Radiance Fields"]);
  });

  it("keeps a display-name input as is", () => {
    const r = runGuard(["Neural Radiance Fields"]);
    expect(r.status).toBe(0);
    expect(r.out).toEqual(["Neural Radiance Fields"]);
    expect(r.stdout).not.toContain("::notice::");
  });

  it("keeps an unknown slug as is", () => {
    const r = runGuard(["no-such-theme"]);
    expect(r.status).toBe(0);
    expect(r.out).toEqual(["no-such-theme"]);
    expect(r.stdout).not.toContain("::notice::");
  });

  it("keeps a slug whose meta.theme is the slug itself or missing", () => {
    const r = runGuard(["flash-attention", "mixture-of-experts"]);
    expect(r.status).toBe(0);
    expect(r.out).toEqual(["flash-attention", "mixture-of-experts"]);
    expect(r.stdout).not.toContain("::notice::");
  });

  it("keeps the slug when the published meta.theme spans lines", () => {
    const r = runGuard(["vision-transformer"]);
    expect(r.status).toBe(0);
    expect(r.out).toEqual(["vision-transformer"]);
    expect(r.stdout).not.toContain("::");
  });

  it("keeps the slug when the published name would fail THEME_RE", () => {
    const r = runGuard(["speculative-decoding"]);
    expect(r.status).toBe(0);
    expect(r.out).toEqual(["speculative-decoding"]);
    expect(r.stdout).not.toContain("::notice::");
  });

  it("never uses a path-like value as a path", () => {
    const r = runGuard(["../themes/neural-radiance-fields", "Mixed, list"]);
    expect(r.status).toBe(0);
    expect(r.out).toEqual(["../themes/neural-radiance-fields", "Mixed, list"]);
  });

  it("handles a mixed list in order", () => {
    const r = runGuard(["Diffusion Models", "neural-radiance-fields", "no-such-theme"]);
    expect(r.status).toBe(0);
    expect(r.out).toEqual(["Diffusion Models", "Neural Radiance Fields", "no-such-theme"]);
  });
});
