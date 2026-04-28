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

  // Map full venue names → conventional acronyms used by the field.
  // Patterns match case-insensitively against the trimmed input. The list is
  // ordered most-specific first (e.g. NeurIPS-DB before NeurIPS) so the
  // longer / more specific match wins.
  const VENUE_ACRONYMS = [
    [/neurips datasets and benchmarks/i, "NeurIPS-DB"],
    [/neural information processing systems/i, "NeurIPS"],
    [/international conference on machine learning/i, "ICML"],
    [/international conference on learning representations/i, "ICLR"],
    [/computer vision and pattern recognition/i, "CVPR"],
    [/european conference on computer vision/i, "ECCV"],
    [/ieee international conference on computer vision/i, "ICCV"],
    [/international conference on 3d vision/i, "3DV"],
    [/international conference on medical image computing and computer-assisted intervention/i, "MICCAI"],
    [/aaai conference on artificial intelligence/i, "AAAI"],
    [/north american chapter of the association for computational linguistics/i, "NAACL"],
    [/annual meeting of the association for computational linguistics/i, "ACL"],
    [/conference on empirical methods in natural language processing/i, "EMNLP"],
    [/conference on fairness, accountability and transparency/i, "FAccT"],
    [/conference on robot learning/i, "CoRL"],
    [/robotics:\s*science and systems/i, "RSS"],
    [/symposium on operating systems principles/i, "SOSP"],
    [/usenix symposium on operating systems design and implementation/i, "OSDI"],
    [/journal of machine learning research/i, "JMLR"],
    [/trans\.?\s*mach\.?\s*learn\.?\s*res\.?/i, "TMLR"],
    [/international journal of computer vision/i, "IJCV"],
    [/proceedings of the national academy of sciences/i, "PNAS"],
    [/^arxiv(\.org)?$/i, "arXiv"],
    [/^biorxiv$/i, "bioRxiv"],
  ];

  // shortVenue: collapse a full conference / journal name to a familiar
  // acronym ("Neural Information Processing Systems" → "NeurIPS"). Returns
  // the trimmed original when no pattern matches so we do not destroy
  // niche venues (Nature, Science, etc.) that are already short.
  PP.shortVenue = function shortVenue(venue) {
    if (!venue) return "";
    const trimmed = String(venue).trim();
    if (!trimmed) return "";
    for (const [re, abbr] of VENUE_ACRONYMS) {
      if (re.test(trimmed)) return abbr;
    }
    return trimmed;
  };

  // formatVenue: canonical card-header form of "<short venue> <year>".
  // Either field may be missing; output collapses gracefully.
  PP.formatVenue = function formatVenue(venue, year) {
    const v = PP.shortVenue(venue);
    const y = year != null && year !== "" ? String(year) : "";
    return [v, y].filter(Boolean).join(" ");
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
