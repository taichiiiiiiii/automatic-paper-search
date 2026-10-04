import { describe, expect, it } from "vitest";
import { detailFrameUrl } from "../../lib/search-detail";

// Port of the URL-validation cases from
// paperpilot/tests/viewer/test_search_detail_dialog.mjs (SCR-08): the
// detail dialog may only load a same-origin, same-base
// `<conf>-<yyyy>/?paper=<40hex>` URL with no other params and no hash.

const LOCATION = "https://example.test/paper/?q=test&page=2";
const PAPER = "a".repeat(40);

describe("detailFrameUrl", () => {
  it("accepts a valid same-base conference detail link", () => {
    const url = detailFrameUrl(`https://example.test/paper/iclr-2026/?paper=${PAPER}`, LOCATION);
    expect(url?.href).toBe(`https://example.test/paper/iclr-2026/?paper=${PAPER}`);
  });

  it("rejects a cross-origin href", () => {
    expect(detailFrameUrl(`https://evil.test/iclr-2026/?paper=${PAPER}`, LOCATION)).toBeNull();
  });

  it("rejects a path-traversal attempt out of the base directory", () => {
    expect(
      detailFrameUrl(`https://example.test/paper/../private/?paper=${PAPER}`, LOCATION),
    ).toBeNull();
  });

  it("rejects a conference slug missing the -yyyy suffix", () => {
    expect(detailFrameUrl(`https://example.test/paper/iclr/?paper=${PAPER}`, LOCATION)).toBeNull();
  });

  it("rejects a non-40hex paper id", () => {
    expect(
      detailFrameUrl("https://example.test/paper/iclr-2026/?paper=not-hex", LOCATION),
    ).toBeNull();
  });

  it("rejects a duplicated paper param", () => {
    expect(
      detailFrameUrl(
        `https://example.test/paper/iclr-2026/?paper=${PAPER}&paper=${PAPER}`,
        LOCATION,
      ),
    ).toBeNull();
  });

  it("rejects an extra query param beyond paper", () => {
    expect(
      detailFrameUrl(`https://example.test/paper/iclr-2026/?paper=${PAPER}&x=1`, LOCATION),
    ).toBeNull();
  });

  it("rejects a hash fragment", () => {
    expect(
      detailFrameUrl(`https://example.test/paper/iclr-2026/?paper=${PAPER}#frag`, LOCATION),
    ).toBeNull();
  });

  it("rejects an unparsable href", () => {
    expect(detailFrameUrl("not a url::", "not-a-location-either")).toBeNull();
  });
});
