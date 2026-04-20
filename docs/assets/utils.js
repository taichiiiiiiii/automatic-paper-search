// Shared utilities for PaperPilot docs/ viewers.
// Loaded before app.js / lineage.js via a plain <script> tag.
//
// Exposes globals on window.PP (PaperPilot namespace).

(function (root) {
  const PP = root.PP || {};

  PP.escapeHtml = function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  };

  PP.formatStars = function formatStars(n) {
    if (typeof n !== "number" || n <= 0) return "";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return n.toString();
  };

  // Try each URL in order; return the first successful JSON that has .nodes
  // with at least one entry. Returns null if none work.
  PP.loadFirstLineage = async function loadFirstLineage(urls) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        if (data && Array.isArray(data.nodes) && data.nodes.length > 0) {
          return data;
        }
      } catch (_) { /* try next */ }
    }
    return null;
  };

  // Standard fallback chain: real data first, demo as fallback.
  PP.LINEAGE_URLS = ["lineage.json", "lineage-demo.json"];

  root.PP = PP;
})(window);
