import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HomeJsonLd } from "../components/landing/json-ld";
import { Landing } from "../components/landing/landing";
import {
  deriveLandingConferenceState,
  type LandingConferenceState,
  landingMetaCopy,
} from "../lib/landing";
import { buildMetadata } from "../lib/metadata";

/**
 * S0 search-first top page (port of docs/index.html). A server component
 * so it can export `metadata` directly (no sibling layout.tsx needed at
 * the route root, unlike apps/web/app/cvpr-2026 -- see that directory's
 * layout.tsx for why nested client routes need one); all interactive
 * behavior lives in the client component it renders.
 *
 * `<HomeJsonLd />` (row 4 of docs/migration/p2-parity-gaps.md) is a
 * sibling, not a child, of `<Landing />`: it is inert `<head>` data
 * (Next.js App Router hoists the `<script>` it renders into `<head>`
 * automatically), not part of the `<main id="main-content">` page
 * content that `<Landing />` itself renders.
 *
 * UX audit (design 53, トップ・共通): the conference counts and list are
 * read from `public/conferences.json` at build time (the same bytes the
 * browser would fetch -- `scripts/copy-data.ts` copies it before `next
 * build`), so the static HTML, the <title> and the first paint show the
 * real numbers and the catalog links without JavaScript, instead of a
 * hard-coded "10 学会・28,000 本" that jumped (and had gone stale) once
 * the runtime fetch resolved.
 */
function readBuildTimeConferences(): LandingConferenceState {
  try {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "public", "conferences.json"), "utf8"),
    ) as unknown;
    return deriveLandingConferenceState(raw);
  } catch {
    return { kind: "unknown" };
  }
}

const conferences = readBuildTimeConferences();
const copy = landingMetaCopy(conferences);

export const metadata = buildMetadata({
  path: "/",
  title: copy.title,
  description: copy.description,
});

export default function HomePage() {
  return (
    <>
      <HomeJsonLd />
      <Landing initialConferences={conferences} />
    </>
  );
}
