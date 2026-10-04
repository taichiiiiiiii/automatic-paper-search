import type { ReactNode } from "react";
import { conferenceDisplayName } from "../../../lib/lineage/conference-name";
import { listConferenceSlugsWithFile } from "../../../lib/lineage/server-fs";
import { buildMetadata } from "../../../lib/metadata";

/**
 * Ported from docs/<conf>/lineage.html. page.tsx is a Client Component
 * (it fetches the quality manifest and, when eligible, the lineage
 * artifact), so `generateStaticParams` and metadata live here --
 * same split as app/cvpr-2026/layout.tsx.
 *
 * Only conferences that ship a `lineage.json` in docs/ get this route
 * at build time (today: all 10 catalog conferences -- the other 8 have
 * the intentionally-kept empty stub, design doc §9 "消さないもの").
 */
export async function generateStaticParams(): Promise<{ conf: string }[]> {
  const slugs = await listConferenceSlugsWithFile("lineage.json");
  return slugs.map((conf) => ({ conf }));
}

export async function generateMetadata({ params }: { params: Promise<{ conf: string }> }) {
  const { conf } = await params;
  const display = conferenceDisplayName(conf);
  return buildMetadata({
    path: `/${conf}/lineage/`,
    title: `Lineage — ${display} — PaperPilot`,
    description: `${display} の論文系譜（家系図）。品質監査に合格した関係だけを表示します。`,
  });
}

export default function ConferenceLineageLayout({ children }: { children: ReactNode }) {
  return children;
}
