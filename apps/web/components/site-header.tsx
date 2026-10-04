"use client";

/**
 * Global site nav, matching the markup and copy of the current
 * docs/*.html pages' `<nav class="site-nav">` (brand + 探す/系譜/仕組み
 * links). Styled with Tailwind utilities built from the ported design
 * tokens (app/globals.css) rather than the original `.site-nav` CSS
 * rules, which were not ported (component CSS is out of scope for this
 * foundation step; page agents may restyle as they port each page).
 *
 * A client component only because of `usePathname` (for `aria-current`);
 * everything else here is static.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/", label: "探す" },
  { href: "/themes/", label: "系譜" },
  { href: "/how-it-works/", label: "仕組み" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-4 border-b border-rule px-4 py-3 sm:px-6"
      aria-label="グローバル"
    >
      <Link href="/" className="font-serif text-lg font-semibold text-ink">
        PaperPilot
      </Link>
      <ul className="flex gap-4 text-sm">
        {NAV_LINKS.map((link) => {
          const current = pathname === link.href;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={current ? "page" : undefined}
                className={current ? "font-medium text-ink" : "text-ink-muted hover:text-accent"}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
