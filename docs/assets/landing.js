// S0 landing script — populates the intro numerals and the
// collapsible conference list from conferences.json, wires the
// example chips, and hides the conference block while search
// results are visible.
//
(function () {
  "use strict";

  var SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

  // --- Intro numerals + conference list from conferences.json -----
  var ledeN = document.getElementById("s0-n");
  var ledeM = document.getElementById("s0-m");
  var list  = document.getElementById("s0-confs-list");
  var label = document.getElementById("s0-confs-label");

  fetch("conferences.json")
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (confs) {
      if (!Array.isArray(confs) || !confs.length) return;
      var total = confs.reduce(function (sum, c) { return sum + (c.papers || 0); }, 0);
      if (ledeN) ledeN.textContent = String(confs.length);
      if (ledeM) ledeM.textContent = total.toLocaleString("en-US");
      if (!list) return;
      // Sort by paper count descending; defensive slug filter.
      var items = confs
        .filter(function (c) { return SLUG_RE.test(c.name); })
        .sort(function (a, b) { return (b.papers || 0) - (a.papers || 0); });
      var frag = document.createDocumentFragment();
      items.forEach(function (c) {
        var li = document.createElement("li");
        li.className = "s0__conf";
        var a = document.createElement("a");
        a.className = "s0__conf-link";
        a.href = c.name + "/";
        // "ICLR 2026" from slug "iclr-2026". Uppercase + space.
        var m = /^(.*)-(\d{4})$/.exec(c.name);
        a.textContent = m
          ? m[1].toUpperCase() + " " + m[2]
          : c.name.toUpperCase();
        var count = document.createElement("span");
        count.className = "s0__conf-count";
        count.setAttribute("aria-label", (c.papers || 0) + " 本");
        count.textContent = String(c.papers || 0);
        li.appendChild(a);
        li.appendChild(count);
        frag.appendChild(li);
      });
      list.appendChild(frag);
      if (label) label.textContent = "学会から探す (" + items.length + ")";
    })
    .catch(function (err) {
      // Fetch failure: leave the intro numerals at their HTML
      // fallback and don't render the list (the <ul hidden> keeps
      // it collapsed). The page stays truthful either way.
      // eslint-disable-next-line no-console
      console.warn("[s0] conferences.json load failed:", err);
    });

  // --- Collapsible toggle (既定で閉) ------------------------------
  var toggle = document.getElementById("s0-confs-toggle");
  if (toggle && list) {
    toggle.addEventListener("click", function () {
      var expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      list.hidden = expanded;
    });
  }

  // --- Example chips: click -> fill input -> run search ---------
  var input = document.querySelector(".site-search__input");
  var chips = document.querySelectorAll(".s0__chip[data-query]");
  if (input) {
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        var q = chip.getAttribute("data-query") || "";
        input.value = q;
        // search.js listens on 'input' to drive the debounced run.
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });
    });
  }

  // --- Focus on load, fine-pointer only -------------------------
  // A bare `autofocus` attribute yanks the software keyboard open on
  // touch devices; gate it so only mouse/trackpad visitors get the
  // instant caret.
  if (input && window.matchMedia && window.matchMedia("(pointer: fine)").matches) {
    input.focus();
  }

  // --- ?q= permalink: read on load, keep in sync while typing ---
  // Loading /?q=diffusion must land on the same inline results the
  // user saw when they copied the URL. search.js itself only *emits*
  // ?q= links toward the catalogs, so the landing owns this sync.
  if (input) {
    var initialQ = new URLSearchParams(window.location.search).get("q");
    if (initialQ) {
      input.value = initialQ;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    var urlTimer = null;
    input.addEventListener("input", function () {
      clearTimeout(urlTimer);
      urlTimer = setTimeout(function () {
        var url = new URL(window.location.href);
        var q = input.value.trim();
        if (q) {
          url.searchParams.set("q", q);
        } else {
          url.searchParams.delete("q");
        }
        window.history.replaceState(null, "", url);
      }, 300);
    });
  }

  // --- Hide conference block while search has results -----------
  // We watch the result list's `hidden` attribute: search.js sets
  // it true when the list is cleared / closed, false when hits
  // render. The collapsible is hidden whenever the list is
  // visible, and restored when the query is cleared or Esc is
  // pressed (both paths close the list in search.js).
  var confs = document.getElementById("s0-confs");
  var resultList = document.getElementById("s0-search-listbox");
  if (confs && resultList && "MutationObserver" in window) {
    var mo = new MutationObserver(function () {
      // list.hidden === true  => no results / list closed => show confs
      // list.hidden === false => hits are rendered           => hide confs
      if (resultList.hidden) {
        confs.classList.remove("is-hidden-by-search");
      } else {
        confs.classList.add("is-hidden-by-search");
      }
    });
    mo.observe(resultList, { attributes: true, attributeFilter: ["hidden"] });
  }
})();
