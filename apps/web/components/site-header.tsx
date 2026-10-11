"use client";

/**
 * Global site header: brand + 探す / 学会 / 系譜 / 仕組み (lib/site-nav.ts).
 * Styled with Tailwind utilities built from the ported design tokens
 * (app/globals.css).
 *
 * UX audit (design 53, トップ・共通): a `<header>` landmark around the
 * nav; every link is at least 44px tall (they were 17px); the current
 * page is shown by colour AND an underline, not colour alone (and the
 * colour now actually applies -- the global `a` rule used to override
 * these utilities, see globals.css `@layer base`).
 *
 * A client component only because of `usePathname` (for `aria-current`);
 * everything else here is static.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { currentNavKey, NAV_LINKS } from "../lib/site-nav";

export function SiteHeader() {
  const current = currentNavKey(usePathname());

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 border-b border-rule px-4 sm:px-6">
      <Link
        href="/"
        className="inline-flex min-h-11 items-center font-serif text-lg font-semibold text-ink hover:text-accent-strong hover:no-underline"
      >
        PaperPilot
      </Link>
      <nav aria-label="グローバル">
        <ul className="m-0 flex list-none gap-1 p-0 text-sm sm:gap-2">
          {NAV_LINKS.map((link) => {
            const isCurrent = current === link.key;
            return (
              <li key={link.key}>
                <Link
                  href={link.href}
                  prefetch={false}
                  aria-current={isCurrent ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center px-2 underline-offset-[6px] ${
                    isCurrent
                      ? "font-semibold text-ink underline decoration-accent decoration-2"
                      : "text-ink-muted hover:text-accent-strong"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
