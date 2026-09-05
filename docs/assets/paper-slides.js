(function () {
  "use strict";

  const interactiveTags = new Set([
    "A",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "SUMMARY",
  ]);

  function slideIndexForHash(hash, ids) {
    if (typeof hash !== "string" || !Array.isArray(ids)) {
      return null;
    }
    const index = ids.indexOf(hash.slice(1));
    return /^#s\d{2}$/.test(hash) && index >= 0 ? index : null;
  }

  function citationIdForHash(hash) {
    if (typeof hash !== "string" || !/^#citation-c(?:0[1-9]|[1-9]\d)$/.test(hash)) {
      return null;
    }
    return hash.slice(1);
  }

  function targetIndexForKey(key, currentIndex, count) {
    if (!Number.isInteger(currentIndex) || !Number.isInteger(count) || count < 1) {
      return null;
    }
    if (key === "ArrowRight" || key === "PageDown") {
      return Math.min(currentIndex + 1, count - 1);
    }
    if (key === "ArrowLeft" || key === "PageUp") {
      return Math.max(currentIndex - 1, 0);
    }
    if (key === "Home") {
      return 0;
    }
    if (key === "End") {
      return count - 1;
    }
    return null;
  }

  function isInteractiveTag(tagName) {
    return typeof tagName === "string" && interactiveTags.has(tagName.toUpperCase());
  }

  function scrollBehaviorForMotion(reducesMotion) {
    return reducesMotion ? "auto" : "smooth";
  }

  globalThis.PaperPilotSlidesCore = Object.freeze({
    slideIndexForHash,
    citationIdForHash,
    targetIndexForKey,
    isInteractiveTag,
    scrollBehaviorForMotion,
  });

  if (typeof document === "undefined") {
    return;
  }

  const sequence = document.querySelector(".slide-deck-sequence");
  if (!sequence) {
    return;
  }

  const slides = Array.from(sequence.querySelectorAll(":scope > .paper-slide"));
  const ids = slides.map((slide) => slide.id);
  if (
    slides.length === 0 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^s\d{2}$/.test(id))
  ) {
    return;
  }

  const citations = new Map();
  for (const item of document.querySelectorAll(".slide-citations__list > li[id]")) {
    if (/^citation-c(?:0[1-9]|[1-9]\d)$/.test(item.id)) {
      item.tabIndex = -1;
      citations.set(item.id, item);
    }
  }

  let currentIndex = 0;
  const reduceMotion = Boolean(
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  const scrollBehavior = scrollBehaviorForMotion(reduceMotion);

  function showSlide(index, shouldFocus) {
    if (!Number.isInteger(index) || index < 0 || index >= slides.length) {
      return;
    }
    currentIndex = index;
    slides.forEach((slide, slideIndex) => {
      slide.hidden = slideIndex !== index;
    });
    if (shouldFocus) {
      slides[index].focus({ preventScroll: true });
      slides[index].scrollIntoView({ block: "start", behavior: scrollBehavior });
    }
  }

  function followHash(shouldFocus) {
    const slideIndex = slideIndexForHash(globalThis.location.hash, ids);
    if (slideIndex !== null) {
      showSlide(slideIndex, shouldFocus);
      return;
    }
    const citationId = citationIdForHash(globalThis.location.hash);
    if (citationId !== null && citations.has(citationId)) {
      const citation = citations.get(citationId);
      citation.focus({ preventScroll: true });
      citation.scrollIntoView({ block: "center", behavior: scrollBehavior });
    }
  }

  document.documentElement.classList.add("paper-slides-enhanced");
  const initialIndex = slideIndexForHash(globalThis.location.hash, ids);
  showSlide(initialIndex === null ? 0 : initialIndex, false);
  followHash(false);

  globalThis.addEventListener("hashchange", function () {
    followHash(true);
  });

  document.addEventListener("keydown", function (event) {
    const target = event.target;
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !target ||
      target.isContentEditable ||
      isInteractiveTag(target.tagName) ||
      (typeof target.closest === "function" &&
        target.closest("a, button, input, select, textarea, summary, [contenteditable='true']"))
    ) {
      return;
    }

    const nextIndex = targetIndexForKey(event.key, currentIndex, slides.length);
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    globalThis.history.replaceState(null, "", `#${ids[nextIndex]}`);
    showSlide(nextIndex, true);
  });
})();
