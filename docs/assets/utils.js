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

  PP.loadLineage = async function loadLineage(url = "lineage.json") {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && Array.isArray(data.nodes) && data.nodes.length > 0) return data;
    } catch (_) { /* fall through */ }
    return null;
  };

  root.PP = PP;
})(window);
