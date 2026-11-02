import { describe, expect, it } from "vitest";
import { tidyTitle } from "../../lib/catalog-text";

describe("tidyTitle (#463)", () => {
  it("turns submission LaTeX into readable characters", () => {
    expect(tidyTitle("$\\Psi$-Sampler: Initial Particle Sampling")).toBe(
      "Ψ-Sampler: Initial Particle Sampling",
    );
    expect(tidyTitle("A$^2$LC: Active Label Correction")).toBe("A²LC: Active Label Correction");
    expect(tidyTitle("D$^{3}$ToM: Decider-Guided")).toBe("D³ToM: Decider-Guided");
    expect(tidyTitle("$A^2Flow:$ Automating")).toBe("A²Flow: Automating");
    expect(tidyTitle("Learning in $\\mathcal{O}(n)$ time")).toBe("Learning in O(n) time");
    expect(tidyTitle("$\\alpha$-divergence and X$_1$")).toBe("α-divergence and X₁");
  });
  it("leaves plain titles untouched and keeps unknown commands readable", () => {
    const plain = "Attention Is All You Need";
    expect(tidyTitle(plain)).toBe(plain);
    expect(tidyTitle("$\\foo$-Net")).toBe("foo-Net");
    expect(tidyTitle("$x^{ab}$")).toBe("x^{ab}"); // letters without a superscript form stay as written
  });
});
