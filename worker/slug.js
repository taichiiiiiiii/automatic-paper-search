// Plain-JS port of paperpilot/scripts/_common.theme_slug() so the CF
// Worker, the public form, and the Node test runner all agree on the
// same slug shape. The pin test paperpilot/tests/test_worker_slug_parity.py
// runs the Python and JS versions against the same inputs and fails on
// divergence.

const SLUG_MAX_LEN = 64;
const NON_ASCII = /[^\x00-\x7F]/g;          // anything outside ASCII range
const SLUG_COLLAPSE = /[^a-z0-9]+/g;        // anything non-alphanumeric → "-"
const SLUG_TRIM = /^-+|-+$/g;
const TRAILING_HYPHEN = /-+$/g;

export function themeSlug(label) {
  if (!label || !label.trim()) {
    throw new Error("theme_slug: label must be non-empty");
  }
  // Python equivalent:
  //   unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode()
  // The NFKD pass splits combining marks (é → e + ◌́) and the ASCII
  // strip drops anything that survived but lies outside the ASCII range
  // (CJK, emoji, etc.). We mirror that here with .normalize("NFKD")
  // followed by a regex that drops non-ASCII codepoints — DO NOT also
  // drop ASCII punctuation here, because the Python version preserves
  // them so they later collapse to a single "-" in the slug step.
  // (Pin: paperpilot/tests/test_worker_slug_parity.py runs this against
  // _common.theme_slug() to catch divergence.)
  const ascii = label.normalize("NFKD").replace(NON_ASCII, "");
  let slug = ascii
    .toLowerCase()
    .replace(SLUG_COLLAPSE, "-")
    .replace(SLUG_TRIM, "");
  if (slug.length > SLUG_MAX_LEN) {
    slug = slug.slice(0, SLUG_MAX_LEN).replace(TRAILING_HYPHEN, "");
  }
  if (!slug) {
    throw new Error(`theme_slug: derived slug is empty for input: ${label}`);
  }
  return slug;
}

export const THEME_INPUT_PATTERN = /^[A-Za-z0-9 _\-]{2,80}$/;
export const SLUG_RE = /^[a-z0-9-]+$/;
