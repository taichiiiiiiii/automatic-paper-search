/**
 * Shared "not ready yet" / "verifying" status section, ported from the
 * `#lineage-audit-status` block in docs/iclr-2026/lineage.html /
 * docs/iclr-2026/deep.html / docs/lineage/index.html. Every lineage
 * route renders exactly this (with page-specific copy) until its
 * quality-manifest gate passes -- see lib/lineage/core.ts
 * `qualityRowIsEligible` and safety-contracts.md SCR-25/SCR-27: no
 * controls, no fetch, no graph, until the audit has actually passed.
 *
 * `role="status" aria-live="polite"` matches the current pages exactly.
 */
export interface AuditStatusProps {
  heading: string;
  message: string;
  backHref?: string;
  backLabel?: string;
  /** `/lineage/` shows this block as the page's only content, with an h1
   * (docs/lineage/index.html `#lineage-audit-heading`); the conference
   * pages already have their own h1, so they keep h2. */
  headingLevel?: 1 | 2;
}

export function AuditStatus({
  heading,
  message,
  backHref,
  backLabel,
  headingLevel = 2,
}: AuditStatusProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section
      id="lineage-audit-status"
      role="status"
      aria-live="polite"
      className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-16 text-center sm:px-6"
    >
      <Heading id="lineage-audit-heading" className="font-serif text-xl font-semibold text-ink">
        {heading}
      </Heading>
      <p className="text-sm text-ink-muted">{message}</p>
      {backHref && backLabel && (
        <p>
          <a href={backHref} className="text-sm font-medium text-accent hover:text-accent-strong">
            {backLabel}
          </a>
        </p>
      )}
    </section>
  );
}
