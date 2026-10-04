import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReactNode } from "react";
import { conferenceDisplayName } from "../../../lib/lineage/conference-name";
import { listConferenceSlugsWithFile } from "../../../lib/lineage/server-fs";
import { buildMetadata } from "../../../lib/metadata";
import { conferenceLineageIsEligible, lineageDataIsNonStub } from "./route-eligibility";

/**
 * Ported from docs/<conf>/lineage.html. page.tsx is a Client Component
 * (it fetches the quality manifest and, when eligible, the lineage
 * artifact), so `generateStaticParams` and metadata live here --
 * same split as app/cvpr-2026/layout.tsx.
 *
 * Only conferences whose `lineage.json` carries real graph data (not
 * the empty stub, design doc §9 "消さないもの") get this route at build
 * time -- today `eccv-2024` and `iclr-2026`, matching which conferences
 * ever shipped a `lineage.html` page originally (the other 8 catalog
 * conferences never had one, so `/[conf]/lineage/` must 404 for them,
 * not render the "監査待ち" pending shell for data that was never meant
 * to have a lineage page at all).
 */
export async function listConferencesWithLineageData(): Promise<string[]> {
  const candidates = await listConferenceSlugsWithFile("lineage.json");
  // P2 review LOW-5: this used to swallow a `readFile` failure here
  // into `null` ("no data for this conference"), the SAME fallback
  // `lineageDataIsNonStub`'s own internal try/catch already uses for
  // malformed JSON. But `candidates` already comes from `readFile`
  // succeeding -- a read failure HERE, for a slug `listConferenceSlugsWithFile`
  // itself found via `stat`, means `public/<conf>/lineage.json` is
  // missing/unreadable despite `docs/<conf>/lineage.json` existing
  // (e.g. the `prebuild` copy step from `docs/` to `public/` did not
  // run, or failed, or raced). That is a build-environment
  // inconsistency, not "this conference legitimately has no lineage
  // data yet" -- it must fail the build loudly (same principle as
  // `lib/lineage/server-fs.ts`'s own `readdir` failure, see that
  // file's header comment), not silently drop the route.
  const withData = await Promise.all(
    candidates.map(async (conf) => {
      const raw = await readFile(join(process.cwd(), "public", conf, "lineage.json"), "utf8");
      return lineageDataIsNonStub(raw) ? conf : null;
    }),
  );
  return withData.filter((conf): conf is string => conf !== null);
}

export async function generateStaticParams(): Promise<{ conf: string }[]> {
  const slugs = await listConferencesWithLineageData();
  return slugs.map((conf) => ({ conf }));
}

/** `null` on any read failure -- `conferenceLineageIsEligible` already
 * treats that the same as "not eligible" (fail closed). */
function readLineageQualityManifest(): string | null {
  try {
    return readFileSync(join(process.cwd(), "public", "lineage-quality-v1.json"), "utf8");
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ conf: string }> }) {
  const { conf } = await params;
  const display = conferenceDisplayName(conf);
  const base = buildMetadata({
    path: `/${conf}/lineage/`,
    title: `Lineage — ${display} — PaperPilot`,
    description: `${display} の論文系譜（家系図）。品質監査に合格した関係だけを表示します。`,
  });
  // Safety contracts CAT-39: this route is built (it has real graph
  // data), but while its quality manifest row is not yet ready+passed
  // -- the client-side gate in page.tsx shows the same "監査待ち"
  // pending state for exactly this reason -- the page must stay
  // crawlable (so it still serves and can transition once the audit
  // passes) but not indexed, the same treatment as the no-JS
  // paper-links duplicate.
  if (conferenceLineageIsEligible(readLineageQualityManifest(), conf)) {
    return base;
  }
  return { ...base, robots: { index: false, follow: true } };
}

export default function ConferenceLineageLayout({ children }: { children: ReactNode }) {
  return children;
}
