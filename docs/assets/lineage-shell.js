// Unified lineage viewer — shell router + selector.
//
// Sits on /lineage/index.html alongside theme.js + theme-request.js.
// Routes by URL param:
//   ?theme=<slug>  → theme.js (chronological viewer) handles it
//                    (theme.js has its own activation gate that checks
//                    for the canvas/svg mount)
//   ?conf=<slug>   → lineage-tree.js mounts the conf tree
//   ?deep=<arxiv>  → lineage-tree.js mounts the deep tree
//   (none/invalid) → render the selector cards
//
// Design spec: DESIGN-372.md §2 S2.
// All DOM built via textContent / createElement — no innerHTML.

(function (root) {
  "use strict";

  const PP = root.PP || {};

  function dataRoot() {
    return (typeof PP.dataRoot === "function" ? PP.dataRoot() : "");
  }

  // Read a single query param, trimmed and non-empty. Returns null
  // when missing or empty so callers can fall through to the selector.
  function readParam(name) {
    const raw = new URLSearchParams(window.location.search).get(name);
    if (!raw) return null;
    const v = String(raw).trim();
    return v || null;
  }

  // Mount point id for the tree controller (conf/deep). lineage-tree.js
  // (V2) looks for this id. V1 creates the empty container so V2 has
  // somewhere to attach when ?conf= / ?deep= is set.
  const TREE_MOUNT_ID = "lineage-tree-mount";

  // ---- Selector --------------------------------------------------------
  //
  // Card grid: 3 theme slugs + 10 conferences (2 with data, 8 empty) +
  // 14 deep trees. Built from the three manifests so adding a theme or
  // conference needs no code change.

  // Conference display names are derived from the manifest slugs —
  // the selector must never hold its own list of conferences (a
  // hardcoded list drifts from docs/lineage-manifest.json; caught
  // live 2026-08-24 with three hallucinated year variants). Only the
  // acronym casing is mapped; unknown acronyms fall back to uppercase.
  const CONF_ACRONYMS = {
    iclr: "ICLR",
    eccv: "ECCV",
    cvpr: "CVPR",
    iccv: "ICCV",
    neurips: "NeurIPS",
    icml: "ICML",
    acl: "ACL",
    emnlp: "EMNLP",
    aaai: "AAAI",
  };

  function confLabel(slug) {
    const m = /^([a-z0-9]+)-(\d{4})$/.exec(slug);
    if (!m) return slug;
    return `${CONF_ACRONYMS[m[1]] || m[1].toUpperCase()} ${m[2]}`;
  }

  // Safe fetch helper — returns null on any failure, never throws.
  async function safeJson(url) {
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  // Build a single selector card. `opts`:
  //   - kind: "theme" | "conf" | "deep"
  //   - href: target URL
  //   - title: card headline
  //   - subtitle: secondary line (may be empty)
  //   - badge: optional badge text (e.g. "ICLR 2026 収録")
  //   - disabled: if true, render as non-link with "未生成" badge
  function buildCard({ kind, href, title, subtitle, badge, disabled }) {
    const card = document.createElement(disabled ? "div" : "a");
    card.className = `selector-card selector-card--${kind}`;
    if (disabled) {
      card.setAttribute("aria-disabled", "true");
    } else {
      card.href = href;
    }

    const titleEl = document.createElement("strong");
    titleEl.className = "selector-card__title";
    titleEl.textContent = title;
    card.appendChild(titleEl);

    if (subtitle) {
      const sub = document.createElement("span");
      sub.className = "selector-card__sub";
      sub.textContent = subtitle;
      card.appendChild(sub);
    }

    if (badge) {
      const b = document.createElement("span");
      b.className = "selector-card__badge";
      b.textContent = badge;
      card.appendChild(b);
    }
    if (disabled) {
      const d = document.createElement("span");
      d.className = "selector-card__badge selector-card__badge--muted";
      d.textContent = "未生成";
      card.appendChild(d);
    }
    return card;
  }

  // Render the selector into the mount. Reads all 3 manifests in
  // parallel, then builds the card grid. Any manifest failure just
  // means that section is omitted — never blocks the whole page.
  async function renderSelector(mount) {
    const root = dataRoot();
    const [lineageManifest, themesManifest, deepManifest] = await Promise.all([
      safeJson(root + "lineage-manifest.json"),
      safeJson(root + "themes/themes-manifest.json"),
      safeJson(root + "iclr-2026/deep-manifest.json"),
    ]);

    const grid = document.createElement("div");
    grid.className = "selector-grid";

    // --- Themes section ---
    if (Array.isArray(themesManifest) && themesManifest.length > 0) {
      const section = document.createElement("section");
      section.className = "selector-section";
      const h = document.createElement("h2");
      h.className = "selector-section__title";
      h.textContent = "テーマで辿る";
      section.appendChild(h);
      const sub = document.createElement("p");
      sub.className = "selector-section__lede";
      sub.textContent = "生成済みのテーマ家系図。";
      section.appendChild(sub);
      const row = document.createElement("div");
      row.className = "selector-row";
      for (const entry of themesManifest) {
        if (!entry || typeof entry.slug !== "string") continue;
        const nodeCount = typeof entry.node_count === "number" ? entry.node_count : null;
        row.appendChild(buildCard({
          kind: "theme",
          href: `?theme=${encodeURIComponent(entry.slug)}`,
          title: typeof entry.theme === "string" ? entry.theme : entry.slug,
          subtitle: nodeCount != null ? `${nodeCount} 本` : "",
        }));
      }
      section.appendChild(row);
      grid.appendChild(section);
    }

    // --- Conferences section ---
    {
      const section = document.createElement("section");
      section.className = "selector-section";
      const h = document.createElement("h2");
      h.className = "selector-section__title";
      h.textContent = "会議で辿る";
      section.appendChild(h);
      const sub = document.createElement("p");
      sub.className = "selector-section__lede";
      sub.textContent = "会議ごとの論文系譜（引用関係の木）。";
      section.appendChild(sub);
      const row = document.createElement("div");
      row.className = "selector-row";
      const confs = lineageManifest?.conferences || {};
      // Manifest-driven: generated lineages first (largest first), then
      // the not-yet-generated set alphabetically.
      const slugs = Object.keys(confs).sort((a, b) => {
        const ea = confs[a] || {};
        const eb = confs[b] || {};
        if (!!ea.has_lineage !== !!eb.has_lineage) return ea.has_lineage ? -1 : 1;
        if ((eb.node_count || 0) !== (ea.node_count || 0)) {
          return (eb.node_count || 0) - (ea.node_count || 0);
        }
        return a.localeCompare(b);
      });
      for (const slug of slugs) {
        const entry = confs[slug];
        const hasLineage = entry && entry.has_lineage === true;
        const nodeCount = entry && typeof entry.node_count === "number" ? entry.node_count : 0;
        row.appendChild(buildCard({
          kind: "conf",
          href: `?conf=${encodeURIComponent(slug)}`,
          title: confLabel(slug),
          subtitle: hasLineage ? `${nodeCount} 本` : "",
          disabled: !hasLineage,
        }));
      }
      section.appendChild(row);
      grid.appendChild(section);
    }

    // --- Deep section ---
    if (Array.isArray(deepManifest) && deepManifest.length > 0) {
      const section = document.createElement("section");
      section.className = "selector-section";
      const h = document.createElement("h2");
      h.className = "selector-section__title";
      h.textContent = "ICLR 2026 収録";
      section.appendChild(h);
      const sub = document.createElement("p");
      sub.className = "selector-section__lede";
      sub.textContent = "注目論文 1 本からの深掘りツリー。";
      section.appendChild(sub);
      const row = document.createElement("div");
      row.className = "selector-row";
      for (const entry of deepManifest) {
        if (!entry || typeof entry.arxiv_id !== "string") continue;
        const title = typeof entry.title === "string"
          ? PP.truncateTitle(entry.title, 80)
          : entry.arxiv_id;
        row.appendChild(buildCard({
          kind: "deep",
          href: `?deep=${encodeURIComponent(entry.arxiv_id)}`,
          title,
          subtitle: "",
          badge: "ICLR 2026",
        }));
      }
      section.appendChild(row);
      grid.appendChild(section);
    }

    // --- Legend (shared) ---
    const legendWrap = document.createElement("div");
    legendWrap.id = "lineage-legend";
    PP.renderRelationLegend(legendWrap);
    grid.appendChild(legendWrap);

    mount.appendChild(grid);
  }

  // ---- Router ----------------------------------------------------------

  function mountTreePlaceholder() {
    // lineage-tree.js (V2) will look for this id and replace its
    // contents. V1 just leaves an empty placeholder with a noscript
    // hint so the page is never visibly broken if tree.js fails to
    // load.
    const mount = document.getElementById(TREE_MOUNT_ID);
    if (!mount) return;
    const hint = document.createElement("p");
    hint.className = "tree-mount__hint";
    hint.textContent = "系譜ツリーをロード中…";
    mount.appendChild(hint);
  }

  // Set a body class so CSS can toggle visibility of the three view
  // mounts. Called on every route() entry. Class is one of:
  //   mode-selector / mode-theme / mode-tree
  function setBodyMode(mode) {
    const b = document.body;
    if (!b) return;
    b.classList.remove("mode-selector", "mode-theme", "mode-tree");
    b.classList.add(`mode-${mode}`);
  }

  async function route() {
    const theme = readParam("theme");
    const conf = readParam("conf");
    const deep = readParam("deep");

    // Count routing params. If >1, pick a deterministic priority:
    // theme > deep > conf (matches the design: theme viewer is the
    // most specific). The selector handles "no params" / "invalid".
    // Shared 6-type legend — rendered in every mode, not just the
    // selector (design §1.2: identical legend on all surfaces).
    for (const id of ["hero-legend", "theme-relation-legend"]) {
      const el = document.getElementById(id);
      if (el && typeof PP.renderRelationLegend === "function") {
        PP.renderRelationLegend(el);
      }
    }

    const n = (theme ? 1 : 0) + (conf ? 1 : 0) + (deep ? 1 : 0);
    if (n > 1) {
      console.warn(
        "lineage-shell: multiple routing params given; priority is theme > deep > conf"
      );
    }
    if (n === 0) {
      setBodyMode("selector");
      const mount = document.getElementById("lineage-selector-mount");
      if (mount) await renderSelector(mount);
      return;
    }

    if (theme) {
      setBodyMode("theme");
      // theme.js's init() runs at module load and checks for
      // ?theme=. Nothing to do here — the canvas/svg elements are
      // already in the HTML and theme.js will take over.
      return;
    }

    if (conf || deep) {
      setBodyMode("tree");
      mountTreePlaceholder();
      // Hand off to the tree controller. Data loading is owned by the
      // shell (lineage-tree.js is a pure renderer — no fetch inside).
      const mount = document.getElementById(TREE_MOUNT_ID);
      if (!mount) return;
      const source = deep ? "deep" : "conf";
      const data = await loadTreeData(source, deep || conf);
      if (!data) {
        // Data fetch failed. Show a friendly explanation in the mount
        // and leave the shell's chrome intact.
        showTreeHint(
          mount,
          deep
            ? `論文「${deep}」の深掘りデータを読み込めませんでした。`
            : `会議「${conf}」の系譜データを読み込めませんでした。`
        );
        return;
      }
      // Empty-stub detection (design v3 §2 S2): meta.source === "none"
      // first, nodes.length === 0 second. An empty stub must never be
      // dressed up as a lineage — say so and route back to the selector.
      const isEmptyStub =
        (data.meta && data.meta.source === "none") ||
        !Array.isArray(data.nodes) ||
        data.nodes.length === 0;
      if (isEmptyStub) {
        showTreeHint(
          mount,
          `会議「${conf || deep}」の系譜はまだ生成されていません。`,
          { backLink: true }
        );
        return;
      }
      if (!root.PPLineageTree || typeof root.PPLineageTree.init !== "function") {
        // lineage-tree.js failed to load — leave the placeholder hint.
        return;
      }
      // Clear the placeholder and mount the real viewer.
      while (mount.firstChild) mount.removeChild(mount.firstChild);
      root.PPLineageTree.init({ source, data, mount });
      return;
    }
  }

  // Replace the mount's contents with a hint message (and optionally a
  // link back to the selector). Used for fetch failures and empty stubs.
  function showTreeHint(mount, text, opts) {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    const msg = document.createElement("p");
    msg.className = "tree-mount__hint";
    msg.textContent = text;
    mount.appendChild(msg);
    if (opts && opts.backLink) {
      const back = document.createElement("p");
      back.className = "tree-mount__hint";
      const a = document.createElement("a");
      a.href = "./";
      a.textContent = "生成済みの系譜を選ぶ →";
      back.appendChild(a);
      mount.appendChild(back);
    }
  }

  // Load the tree data for conf / deep from the resolved data-root.
  // conf: <root><conf>/lineage.json. deep: two-stage — first fetch the
  // manifest to validate the arxiv id, then fetch the specific tree.
  // Returns null on any failure.
  async function loadTreeData(source, key) {
    const root = dataRoot();
    if (source === "conf") {
      // Basic slug guard — only allow path-safe characters so a bogus
      // ?conf= value can't escape the directory.
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(key)) return null;
      return safeJson(root + key + "/lineage.json");
    }
    if (source === "deep") {
      // arxiv id format: 4-5 digits, dot, 4-5 digits, optional version.
      if (!/^\d{4}\.\d{4,5}(v\d+)?$/.test(key)) return null;
      // Two-stage fetch. If the manifest fetch fails we can still try
      // the direct deep-<id>.json path (legacy) so callers with a
      // working id but a missing manifest still land on the tree.
      const manifest = await safeJson(root + "iclr-2026/deep-manifest.json");
      if (Array.isArray(manifest) && manifest.length > 0) {
        const entry = manifest.find((m) => m && m.arxiv_id === key);
        if (!entry) return null;
      }
      return safeJson(root + "iclr-2026/deep-" + key + ".json");
    }
    return null;
  }

  // Run after DOM is ready. The script is loaded with `defer` so the
  // DOM is already parsed at this point.
  route().catch((err) => {
    // Soft-fail: the page still shows the static hero + nav + footer.
    // eslint-disable-next-line no-console
    console.error("[lineage-shell] route failed:", err);
  });

  root.PPLineageShell = { route, renderSelector };
})(window);
