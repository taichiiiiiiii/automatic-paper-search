import { describe, expect, it } from "vitest";
import { classifyTags } from "../../src/catalog/buildSummary.js";
import { pyRegex } from "../../src/catalog/pyRegex.js";

describe("classifyTags", () => {
  it("tags an LLM paper", () => {
    expect(classifyTags("Scaling Large Language Models", "We train a language model.")).toContain(
      "LLM",
    );
  });

  it("tags a diffusion paper", () => {
    expect(classifyTags("A Diffusion Baseline", "A diffusion-based image generator.")).toContain(
      "Diffusion",
    );
  });

  it("does not match 'face' as a verb ('methods face the challenge')", () => {
    expect(classifyTags("A Survey", "Our methods face the challenge of scale.")).not.toContain(
      "Face",
    );
  });

  it("matches 'facial recognition' as the Face tag", () => {
    expect(classifyTags("Facial Recognition", "A study of facial recognition systems.")).toContain(
      "Face",
    );
  });

  it("returns an empty list when nothing matches", () => {
    expect(classifyTags("Untitled", "")).toEqual([]);
  });

  it("matches the Dataset rule's literal \\w* fragment", () => {
    expect(classifyTags("A New Corpus", "We introduce a new dataset for evaluation.")).toContain(
      "Dataset",
    );
  });
});

describe("pyRegex \\b boundary", () => {
  it("matches an ASCII word boundary like JS \\b would", () => {
    const re = pyRegex("\\bllm\\b");
    expect(re.test("the llm model")).toBe(true);
    expect(re.test("the llms model")).toBe(false);
  });

  it("treats a non-ASCII letter as a word character (Python \\w is Unicode)", () => {
    // "café" ends in a non-ASCII word char; JS's native \b (ASCII-only)
    // would treat the boundary after "é" differently in some engines —
    // this asserts our translated boundary agrees with Python's \w
    // (category L) definition: "é" is a word character, so there is NO
    // boundary between "é" and "s".
    const re = pyRegex("café\\b");
    expect(re.test("cafés")).toBe(false);
    expect(re.test("café")).toBe(true);
    expect(re.test("café ")).toBe(true);
  });
});
