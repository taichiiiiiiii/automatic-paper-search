import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Build-time guard shared by `generateStaticParams` in
 * `app/[conf]/page.tsx` and `app/[conf]/paper-links/layout.tsx`.
 *
 * A static export (`output: "export"`) has no server to 404 a missing
 * file at request time: every statically-generated route is written to
 * `out/` once, at build time, and served as-is forever after. Before
 * this guard, a conference listed in `conferences.json` whose
 * `<conf>/papers.json` was missing from `public/` would still get a
 * `/[conf]/paper-links/` route generated; `page.tsx`'s `readPapers`
 * would then fail during that one page's render and (previously) call
 * `notFound()`, which Next statically writes as the not-found page's
 * content served at HTTP 200 -- the build stayed green while silently
 * shipping a 404 look-alike. Failing here, during `generateStaticParams`,
 * fails the whole build loudly instead.
 *
 * `publicDir` is injectable so this is unit-testable against a
 * temporary directory rather than the real `apps/web/public/`.
 */
export function assertConferenceHasPapersJson(
  conf: string,
  publicDir: string = join(process.cwd(), "public"),
): void {
  if (!existsSync(join(publicDir, conf, "papers.json"))) {
    throw new Error(
      `${conf}/papers.json is missing under ${publicDir}; cannot statically build its catalog/paper-links routes`,
    );
  }
}
