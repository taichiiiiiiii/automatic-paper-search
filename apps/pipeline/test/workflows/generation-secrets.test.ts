/**
 * H3 of the P5 tier-A review (pass 1): LLM/S2 secrets were dropped from
 * three generation workflows when they were ported, so every generated
 * run fails (`buildProvider()` throws "No LLM key found" with no key;
 * S2 also runs unauthenticated without its key). This pins the exact
 * secret names each generation step must carry, byte-identical to the
 * live (pre-P5) workflow each one replaces, plus the weekly "no LLM key
 * configured -> retain published lineages, exit 0" guard.
 */
import { describe, expect, it } from "vitest";
import {
  jobsOf,
  listWorkflowFiles,
  readWorkflow,
  readWorkflowRawText,
  type YamlDoc,
} from "./helpers.js";

function jobNamed(doc: YamlDoc, jobId: string): YamlDoc {
  const found = jobsOf(doc).find(([id]) => id === jobId);
  if (!found) throw new Error(`job "${jobId}" not found`);
  return found[1];
}

function stepNamed(job: YamlDoc, stepName: string): YamlDoc {
  const steps: YamlDoc[] = job.steps;
  const step = steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`step ${JSON.stringify(stepName)} not found`);
  return step;
}

describe("H3: generation steps carry the exact LLM/S2 secrets the live workflows pass", () => {
  it('theme-on-demand.yml\'s generate/"Generate theme lineage" step', () => {
    const step = stepNamed(
      jobNamed(readWorkflow("theme-on-demand.yml"), "generate"),
      "Generate theme lineage",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
    expect(step.env?.PAPERPILOT_GROQ_API_KEY).toBe("${{ secrets.PAPERPILOT_GROQ_API_KEY }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
    expect(step.env?.PAPERPILOT_S2_API_KEY).toBe("${{ secrets.PAPERPILOT_S2_API_KEY }}");
    // R2-6 (design 41 D2): Gemini free tier is the fallback classifier.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
    expect(step.env?.PAPERPILOT_GEMINI_API_KEY).toBe("${{ secrets.PAPERPILOT_GEMINI_API_KEY }}");
  });

  it('regen-themes.yml\'s generate/"Regenerate requested themes" step', () => {
    const step = stepNamed(
      jobNamed(readWorkflow("regen-themes.yml"), "generate"),
      "Regenerate requested themes",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
    expect(step.env?.PAPERPILOT_GROQ_API_KEY).toBe("${{ secrets.PAPERPILOT_GROQ_API_KEY }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
    expect(step.env?.PAPERPILOT_S2_API_KEY).toBe("${{ secrets.PAPERPILOT_S2_API_KEY }}");
    // R2-6 (design 41 D2): Gemini free tier is the fallback classifier.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
    expect(step.env?.PAPERPILOT_GEMINI_API_KEY).toBe("${{ secrets.PAPERPILOT_GEMINI_API_KEY }}");
  });

  it('collect-weekly.yml\'s generate/"Regenerate eligible conference lineages" step', () => {
    const step = stepNamed(
      jobNamed(readWorkflow("collect-weekly.yml"), "generate"),
      "Regenerate eligible conference lineages",
    );
    // The repo registers PAPERPILOT_GROQ_API_KEY (the name theme/regen use);
    // GROQ_API_KEY stays as a fallback for the pre-P5 name.
    expect(step.env?.PAPERPILOT_GROQ_API_KEY).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
      "${{ secrets.PAPERPILOT_GROQ_API_KEY || secrets.GROQ_API_KEY }}",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
    expect(step.env?.PAPERPILOT_GEMINI_API_KEY).toBe("${{ secrets.GEMINI_API_KEY }}");
  });

  it("collect-weekly.yml's generate/\"Run PaperPilot collector\" step reads the S2 key under the theme workflows' name", () => {
    const step = stepNamed(
      jobNamed(readWorkflow("collect-weekly.yml"), "generate"),
      "Run PaperPilot collector",
    );
    // R0-2: the collector reads PAPERPILOT_S2_API_KEY (collect/config/env.ts);
    // the secret is PAPERPILOT_S2_API_KEY everywhere, with the pre-P5
    // S2_API_KEY kept only as a fallback.
    expect(step.env?.PAPERPILOT_S2_API_KEY).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
      "${{ secrets.PAPERPILOT_S2_API_KEY || secrets.S2_API_KEY }}",
    );
  });

  it("no workflow reads the S2 key from secrets.S2_API_KEY without preferring PAPERPILOT_S2_API_KEY", () => {
    const files = listWorkflowFiles();
    expect(files).toContain("collect-weekly.yml");
    for (const name of files) {
      for (const line of readWorkflowRawText(name).split("\n")) {
        if (!/secrets\.S2_API_KEY\b/.test(line)) continue;
        expect(line, `${name}: ${line.trim()}`).toContain(
          "secrets.PAPERPILOT_S2_API_KEY || secrets.S2_API_KEY",
        );
      }
    }
  });

  it("collect-weekly.yml's lineage step restores the no-LLM-key retain-and-exit-0 guard", () => {
    const step = stepNamed(
      jobNamed(readWorkflow("collect-weekly.yml"), "generate"),
      "Regenerate eligible conference lineages",
    );
    const run: string = step.run;
    expect(run).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash `${VAR:-}` expansion from the workflow's run: script, not a JS template literal.
      'if [ -z "${PAPERPILOT_GROQ_API_KEY:-}" ] && [ -z "${PAPERPILOT_GEMINI_API_KEY:-}" ]',
    );
    expect(run).toContain("no lineage LLM key configured; retaining published lineages");
    expect(run).toMatch(
      /no lineage LLM key configured; retaining published lineages"\s*\n\s*exit 0/,
    );
  });
});
