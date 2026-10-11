import { describe, expect, it } from "vitest";
import {
  lineageShelfEmptyText,
  lineageShelfLede,
  lineageShelfStatus,
} from "../../lib/landing-lineage";

// Design 48 P0-4: the static HTML (pre-hydration, crawlers, no-JS) said
// "公開条件を満たす系譜は現在ありません" while four themes were published,
// because the initial state was "closed". The initial state is now
// "loading", whose copy must not claim anything about publication.
describe("landing lineage shelf copy", () => {
  it("never says 'nothing published' while loading", () => {
    for (const text of [
      lineageShelfLede("loading"),
      lineageShelfStatus("loading"),
      lineageShelfEmptyText("loading"),
    ]) {
      expect(text).not.toMatch(/ありません|準備中/);
    }
  });

  it("keeps the truthful empty / failure copy", () => {
    expect(lineageShelfStatus("closed")).toBe("公開条件を満たす系譜は現在ありません。");
    expect(lineageShelfStatus("failed")).toBe("系譜一覧を読み込めませんでした。");
    expect(lineageShelfLede("open")).toContain("公開しています");
  });
});
