import { describe, expect, it } from "vitest";
import { safeHref } from "../../lib/catalog-text";
import { upgradeKnownHttps } from "../../lib/https-upgrade";

describe("upgradeKnownHttps", () => {
  it.each([
    ["http://arxiv.org/abs/2601.02771v1", "https://arxiv.org/abs/2601.02771v1"],
    ["http://ARXIV.org/pdf/1", "https://ARXIV.org/pdf/1"],
    ["http://openreview.net/forum?id=x", "https://openreview.net/forum?id=x"],
    ["http://doi.org/10.1/x", "https://doi.org/10.1/x"],
    ["http://aclanthology.org", "https://aclanthology.org"],
  ])("upgrades %s", (input, expected) => {
    expect(upgradeKnownHttps(input)).toBe(expected);
  });

  it.each([
    "https://arxiv.org/abs/1",
    "http://example.org/arxiv.org/abs/1",
    "http://arxiv.org.evil.example/abs/1",
    "http://arxiv.org:8080/abs/1",
    "ftp://arxiv.org/abs/1",
    "",
  ])("leaves %s unchanged", (input) => {
    expect(upgradeKnownHttps(input)).toBe(input);
  });

  it("is applied by safeHref (catalog cards)", () => {
    expect(safeHref("http://arxiv.org/abs/1")).toBe("https://arxiv.org/abs/1");
    expect(safeHref("javascript:alert(1)")).toBe("#");
  });
});
