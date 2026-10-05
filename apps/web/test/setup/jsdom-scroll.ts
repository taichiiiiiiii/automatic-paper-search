/**
 * jsdom implements neither Element.prototype.scrollTo nor scrollIntoView.
 * Components call them from requestAnimationFrame (deep-lineage-app's
 * scrollToFocus), so a frame that fires before a test's cleanup threw an
 * unhandled TypeError and failed the whole run even though every test
 * passed. Real browsers all have both; this only fills the jsdom gap.
 * Tests that assert on scrolling still spy on these with vi.spyOn.
 */
if (typeof Element !== "undefined") {
  if (typeof Element.prototype.scrollTo !== "function") {
    Element.prototype.scrollTo = () => {};
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
}
