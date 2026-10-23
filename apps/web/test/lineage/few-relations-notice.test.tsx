// @vitest-environment jsdom
/**
 * R2-43: an unaudited lineage with fewer than 3 relations says so.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  FEW_RELATIONS_BELOW,
  fewRelationsNote,
  PublicationNotice,
} from "../../components/lineage/publication-badge";

describe("PublicationNotice few-relations note (R2-43)", () => {
  it("shows the count when an unaudited lineage has fewer than 3 relations", () => {
    const { container } = render(<PublicationNotice tier="unaudited" strongRelationCount={0} />);
    expect(container.querySelector("[data-few-relations]")?.textContent).toBe(fewRelationsNote(0));
    expect(screen.getByText(/判定できたのは 0 件だけです/)).toBeTruthy();
  });

  it("stays quiet at the threshold, for audited, and when the count is unknown", () => {
    for (const props of [
      { tier: "unaudited", strongRelationCount: FEW_RELATIONS_BELOW },
      { tier: "audited", strongRelationCount: 0 },
      { tier: "unaudited" },
    ] as const) {
      const { container, unmount } = render(<PublicationNotice {...props} />);
      expect(container.querySelector("[data-few-relations]")).toBeNull();
      unmount();
    }
  });
});
