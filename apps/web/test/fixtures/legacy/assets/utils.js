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

  // Truncate a paper title for <title> use without cutting mid-word:
  // cut at the last space inside the budget when one exists past the
  // halfway point, else hard-cut (CJK titles have no spaces). Adds an
  // ellipsis so the cut is visibly deliberate.
  PP.truncateTitle = function truncateTitle(s, max = 60) {
    const str = String(s || "");
    // Count code points, not UTF-16 units, so an astral char (emoji etc.)
    // sitting on the boundary is never split into an unpaired surrogate.
    const chars = Array.from(str);
    if (chars.length <= max) return str;
    const cut = chars.slice(0, max).join("");
    const sp = cut.lastIndexOf(" ");
    return (sp > max / 2 ? cut.slice(0, sp) : cut) + "…";
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
    // IEEE journals — order matters (most specific first)
    [/ieee\/?\s*transactions on pattern analysis and machine intelligence/i, "TPAMI"],
    [/ieee\/?\s*transactions on geoscience and remote sensing/i, "TGRS"],
    [/ieee\/?\s*transactions on circuits and systems for video technology/i, "TCSVT"],
    [/ieee\/?\s*transactions on image processing/i, "TIP"],
    [/ieee\/?\s*transactions on multimedia/i, "TMM"],
    [/ieee\/?\s*transactions on neural networks and learning systems/i, "TNNLS"],
    [/ieee\/?\s*transactions on robotics/i, "T-RO"],
    // IEEE conferences
    [/ieee\/cvf conference on computer vision and pattern recognition/i, "CVPR"],
    [/ieee\s*workshop\/winter conference on applications of computer vision/i, "WACV"],
    [/winter conference on applications of computer vision/i, "WACV"],
    // RSJ is correct, RJS appears as a S2 typo — accept either
    [/ieee\/?(rsj|rjs)?\s*international conference on intelligent robots and systems/i, "IROS"],
    [/international conference on intelligent transportation systems/i, "ITSC"],
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
      // Default cache — lineage.json is regenerated by the weekly collect
      // job (conference) or the on-demand workflow (theme), and the GH
      // Pages CDN serves the new asset on the next deploy. Polling paths
      // that need stricter freshness pass their own Request with explicit
      // cache options upstream.
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      if (data && Array.isArray(data.nodes) && data.nodes.length > 0) return data;
    } catch (_) { /* fall through */ }
    return null;
  };

  // Edge visual hierarchy, shared by all family-tree viewers (theme /
  // conference / deep). Scales the confidence→{opacity,width} mapping per
  // relation so the descent backbone (successor/supersedes) reads as the
  // trunk and branches (extends/ablation/baseline) recede into a quiet
  // field instead of flooding the graph. Hue stays in the CSS --rel-*
  // tokens (the legend + 仕組み page describe those colours); this only
  // sets weight/opacity. `mc` is the CSS-class relation — callers map
  // baseline_only → baseline first. Returns null when conf isn't numeric,
  // so the caller keeps the CSS fallback width + full opacity.
  // EDGE_MIN_WIDTH floors a low-conf branch so it never collapses to a
  // sub-pixel hairline (marker-end scales with strokeWidth).
  const REL_EDGE_WEIGHT = {
    supersedes: { w: 1.0,  op: 1.0  },
    successor:  { w: 1.0,  op: 1.0  },
    contrasts:  { w: 0.9,  op: 0.95 },
    ablation:   { w: 0.7,  op: 0.84 },
    baseline:   { w: 0.7,  op: 0.82 },
    extends:    { w: 0.62, op: 0.76 },
  };
  const EDGE_MIN_WIDTH = 0.9;
  PP.edgeStyle = function edgeStyle(mc, conf) {
    if (typeof conf !== "number") return null;
    if (mc === "baseline_only") mc = "baseline";  // accept raw rel too
    const k = REL_EDGE_WEIGHT[mc] || { w: 0.85, op: 0.92 };
    return {
      opacity: ((0.5 + conf * 0.5) * k.op).toFixed(3),
      width: Math.max((1 + conf * 1.5) * k.w, EDGE_MIN_WIDTH).toFixed(2),
    };
  };

  // Fan-out: spread each parent's outgoing edges across the bottom edge of
  // its card (ordered left→right by child x) so multiple children don't all
  // radiate from one point — a tree's branches leave the trunk at different
  // places, which de-tangles the dense graphs. Returns Map(edge → x-offset
  // to add to the parent's centre). Only the ORIGIN moves; callers keep the
  // curve landing on the child's top-centre, so marker-end orientation is
  // unchanged. `nodeW` is the viewer's card width (theme 260 / lineage 220 /
  // deep 240). Shared by all three family-tree viewers.
  const EDGE_FAN_STEP = 18;       // px between adjacent origins
  const EDGE_FAN_MAX_FRAC = 0.55; // origins span at most 55% of the card width
  PP.fanOffsets = function fanOffsets(edges, posById, nodeW) {
    const bySrc = new Map();
    for (const e of edges) {
      if (!posById.has(e.src) || !posById.has(e.dst)) continue;
      if (!bySrc.has(e.src)) bySrc.set(e.src, []);
      bySrc.get(e.src).push(e);
    }
    const out = new Map();
    for (const group of bySrc.values()) {
      group.sort((p, q) => posById.get(p.dst)._x - posById.get(q.dst)._x);
      const n = group.length;
      const span = Math.min(nodeW * EDGE_FAN_MAX_FRAC, (n - 1) * EDGE_FAN_STEP);
      group.forEach((e, i) => out.set(e, n > 1 ? (i / (n - 1) - 0.5) * span : 0));
    }
    return out;
  };

  root.PP = PP;
})(window);
