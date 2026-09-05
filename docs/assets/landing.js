// S0 landing helpers: conference counts and disclosure, example chips,
// pointer-gated focus, and the fail-closed audited-lineage shelf.
(function () {
  "use strict";

  var SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
  // A passed artifact is not enough to expose a route: only conferences
  // that also ship a fail-closed lineage.html viewer can be linked.
  var CONFERENCE_VIEWERS = new Set(["eccv-2024", "iclr-2026"]);
  var LineageCore = window.PaperPilotLineageCore;

  function venueLabel(slug) {
    var match = /^(.*)-(\d{4})$/.exec(slug);
    return match ? match[1].toUpperCase() + " " + match[2] : slug.toUpperCase();
  }

  // --- Intro numerals + conference list -------------------------
  var ledeN = document.getElementById("s0-n");
  var ledeM = document.getElementById("s0-m");
  var list = document.getElementById("s0-confs-list");
  var label = document.getElementById("s0-confs-label");

  fetch("conferences.json", { cache: "no-cache" })
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then(function (conferences) {
      if (!Array.isArray(conferences) || !conferences.length) return;
      var valid = conferences.filter(function (conference) {
        return conference && typeof conference.name === "string" &&
          SLUG_RE.test(conference.name) &&
          Number.isSafeInteger(conference.papers) && conference.papers >= 0;
      });
      var total = valid.reduce(function (sum, conference) {
        return sum + conference.papers;
      }, 0);
      if (ledeN) ledeN.textContent = String(valid.length);
      if (ledeM) ledeM.textContent = total.toLocaleString("en-US");
      if (!list) return;

      valid.sort(function (a, b) {
        return b.papers - a.papers || a.name.localeCompare(b.name);
      });
      var fragment = document.createDocumentFragment();
      valid.forEach(function (conference) {
        var item = document.createElement("li");
        item.className = "s0__conf";
        var anchor = document.createElement("a");
        anchor.className = "s0__conf-link";
        anchor.href = encodeURIComponent(conference.name) + "/";
        anchor.textContent = venueLabel(conference.name);
        var count = document.createElement("span");
        count.className = "s0__conf-count";
        count.setAttribute("aria-label", conference.papers + " 本");
        count.textContent = String(conference.papers);
        item.append(anchor, count);
        fragment.append(item);
      });
      list.replaceChildren(fragment);
      if (label) label.textContent = "学会から探す (" + valid.length + ")";
    })
    .catch(function (error) {
      console.warn("[s0] conferences.json load failed:", error);
    });

  var toggle = document.getElementById("s0-confs-toggle");
  if (toggle && list) {
    toggle.addEventListener("click", function () {
      var expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      list.hidden = expanded;
    });
  }

  // --- Example chips --------------------------------------------
  var input = document.querySelector(".site-search__input");
  var chips = document.querySelectorAll(".s0__chip[data-query]");
  if (input) {
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        input.value = chip.getAttribute("data-query") || "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });
    });
  }

  if (input && window.matchMedia && window.matchMedia("(pointer: fine)").matches) {
    input.focus();
  }

  // --- Audited lineage shelf ------------------------------------
  // Only collections that are both usable and audit-passed enter the
  // normal navigation. A failed or malformed quality model fails closed.
  var lineageList = document.getElementById("s0-lineages-list");
  var lineageStatus = document.getElementById("s0-lineages-status");
  var lineageNote = document.getElementById("s0-lineage-note");

  function lineageHref(collection) {
    if (collection.kind === "theme") {
      return "themes/?theme=" + encodeURIComponent(collection.slug);
    }
    return encodeURIComponent(collection.slug) + "/lineage.html";
  }

  function lineageItem(collection) {
    var item = document.createElement("li");
    item.className = "s0__lineage";
    var anchor = document.createElement("a");
    anchor.className = "s0__lineage-link";
    anchor.href = lineageHref(collection);
    anchor.textContent = collection.label;

    var meta = document.createElement("span");
    meta.className = "s0__lineage-meta";
    meta.textContent = (collection.kind === "theme" ? "テーマ" : "学会") +
      " · " + collection.node_count + " 論文 · " + collection.edge_count + " 関係";
    item.append(anchor, meta);

    if (collection.freshness === "stale") {
      var stale = document.createElement("span");
      stale.className = "s0__lineage-stale";
      var date = collection.snapshot_date || collection.generated_at || "日付不明";
      stale.textContent = "更新確認が必要 · " + String(date).slice(0, 10);
      item.append(stale);
    }
    return item;
  }

  if (lineageList) {
    fetch("lineage-quality-v1.json", { cache: "no-cache" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (quality) {
        if (!LineageCore || typeof LineageCore.parseQualityManifest !== "function" ||
            typeof LineageCore.qualityRowIsEligible !== "function") {
          throw new Error("lineage quality reader unavailable");
        }
        var parsed = LineageCore.parseQualityManifest(quality);
        if (!parsed) {
          throw new Error("invalid quality manifest");
        }
        var visible = parsed.collections.filter(function (collection) {
          return collection &&
            (collection.kind === "theme" || collection.kind === "conference") &&
            typeof collection.slug === "string" && SLUG_RE.test(collection.slug) &&
            typeof collection.label === "string" && collection.label.length > 0 &&
            Number.isSafeInteger(collection.node_count) && collection.node_count > 0 &&
            Number.isSafeInteger(collection.edge_count) && collection.edge_count >= 0 &&
            (collection.kind === "theme" || CONFERENCE_VIEWERS.has(collection.slug)) &&
            LineageCore.qualityRowIsEligible(collection);
        });
        if (!visible.length) {
          var empty = document.createElement("li");
          empty.className = "s0__lineage-empty";
          empty.textContent = "監査済みの系譜は準備中です。学会カタログは通常どおり利用できます。";
          lineageList.replaceChildren(empty);
          if (lineageStatus) lineageStatus.textContent = "公開条件を満たす系譜は現在ありません。";
          return;
        }
        lineageList.replaceChildren(...visible.map(lineageItem));
        if (lineageNote) lineageNote.textContent = "監査済みの系譜を公開しています。";
        if (lineageStatus) {
          lineageStatus.textContent = visible.length + " 件の監査済み系譜を表示しています。";
        }
      })
      .catch(function (error) {
        console.warn("[s0] lineage quality load failed:", error);
        var failed = document.createElement("li");
        failed.className = "s0__lineage-empty";
        failed.textContent = "系譜一覧を読み込めませんでした。学会カタログから論文を探せます。";
        lineageList.replaceChildren(failed);
        if (lineageStatus) lineageStatus.textContent = "系譜一覧を読み込めませんでした。";
      });
  }
})();
