/**
 * R2-9 evaluation entry point. The rule sets moved to
 * `../classify/apiRelations.ts` in R2-10 (design 41 D6), where theme
 * generation uses rule set v2 in production; this re-export keeps the
 * evaluation CLI and its hand-checked fixture test on the same code.
 */
export * from "../classify/apiRelations.js";
