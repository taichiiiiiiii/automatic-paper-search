/**
 * Upgrades `http://` links to scholarly hosts that serve (and redirect to)
 * HTTPS anyway. The arXiv API returns `http://arxiv.org/abs/...` ids, so
 * catalogs built from it (aaai-2026, eccv-2024) carried plain-http outbound
 * links: an extra redirect hop for every reader and a downgrade a network
 * attacker could intercept. Only hosts known to serve HTTPS are upgraded;
 * any other URL is returned unchanged.
 */
const HTTPS_HOSTS = new Set([
  "arxiv.org",
  "www.arxiv.org",
  "export.arxiv.org",
  "openreview.net",
  "aclanthology.org",
  "openaccess.thecvf.com",
  "doi.org",
  "dx.doi.org",
  "proceedings.mlr.press",
  "proceedings.neurips.cc",
  "papers.nips.cc",
  "proceedings.iclr.cc",
  "www.ecva.net",
  "ojs.aaai.org",
]);

export function upgradeKnownHttps(url: string): string {
  const m = /^http:\/\/([^/?#:]+)(?=[/?#]|$)/i.exec(url);
  if (!m || !HTTPS_HOSTS.has(m[1]!.toLowerCase())) return url;
  return `https://${url.slice("http://".length)}`;
}
