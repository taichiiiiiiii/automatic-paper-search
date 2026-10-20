import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LINEAGE_FEEDBACK_FIELDS,
  LINEAGE_FEEDBACK_LABEL,
  LINEAGE_FEEDBACK_TEMPLATE,
  lineageFeedbackIssueUrl,
} from "../../lib/lineage/feedback";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(
  TEST_DIR,
  "..",
  "..",
  "..",
  "..",
  ".github",
  "ISSUE_TEMPLATE",
  LINEAGE_FEEDBACK_TEMPLATE,
);

const args = {
  theme: { name: "Flash Attention", slug: "flash-attention" },
  edge: {
    src: "openalex:W1",
    dst: "openalex:W2",
    relation: "supersedes",
    confidence: 0.85,
    rationale: "x",
    provenance: { classification: { method: "s2_context_rule" } },
  },
  older: { id: "openalex:W1", title: "FlashAttention", year: 2022 },
  newer: { id: "openalex:W2", title: "FlashAttention-2", year: 2023 },
  pageUrl: "https://paperpilot.pages.dev/themes/?theme=flash-attention&node=openalex%3AW2",
};

describe("lineage feedback issue link (design 48 P0-2)", () => {
  it("labels a rule-inferred strong relation as a candidate when unaudited (D-R2-40)", () => {
    const q = new URL(lineageFeedbackIssueUrl({ ...args, audited: false })).searchParams;
    expect(q.get("title")).toContain("→ 置換（候補） →");
    expect(q.get("relation")).toBe("置換（supersedes、規則で推定した候補）");
  });

  it("opens the issue form with every field prefilled", () => {
    const url = new URL(lineageFeedbackIssueUrl({ ...args, audited: true }));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/taichiiiiiiii/automatic-paper-search/issues/new",
    );
    const q = url.searchParams;
    expect(q.get("template")).toBe(LINEAGE_FEEDBACK_TEMPLATE);
    expect(q.get("labels")).toBe(LINEAGE_FEEDBACK_LABEL);
    expect(q.get("title")).toBe(
      "[系譜の誤り] Flash Attention: FlashAttention → 置換 → FlashAttention-2",
    );
    expect(q.get("theme")).toBe("Flash Attention (flash-attention)");
    expect(q.get("relation")).toBe("置換（supersedes）");
    expect(q.get("older")).toBe("openalex:W1 — FlashAttention (2022)");
    expect(q.get("newer")).toBe("openalex:W2 — FlashAttention-2 (2023)");
    expect(q.get("method")).toMatch(/・確信度 0\.85$/);
    expect(q.get("page")).toBe(args.pageUrl);
  });

  it("drops a non-http page URL and clips long titles", () => {
    const long = "L".repeat(2000);
    const url = new URL(
      lineageFeedbackIssueUrl({
        ...args,
        older: { id: "a", title: long },
        pageUrl: "javascript:alert(1)",
      }),
    );
    expect(url.searchParams.has("page")).toBe(false);
    expect((url.searchParams.get("title") ?? "").length).toBeLessThanOrEqual(120);
    expect((url.searchParams.get("older") ?? "").length).toBeLessThanOrEqual(400);
    expect(url.toString().length).toBeLessThan(8000);
  });

  it("matches the field ids of .github/ISSUE_TEMPLATE/lineage-feedback.yml", () => {
    const yml = readFileSync(TEMPLATE, "utf8");
    const ids = [...yml.matchAll(/^\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    for (const field of LINEAGE_FEEDBACK_FIELDS) expect(ids).toContain(field);
    expect(yml).toMatch(new RegExp(`labels: \\["${LINEAGE_FEEDBACK_LABEL}"\\]`));
  });
});
