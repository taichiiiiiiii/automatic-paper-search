import type { ReactNode } from "react";
import { conferenceDisplayName } from "../../../lib/lineage/conference-name";
import { listConferenceSlugsWithFile } from "../../../lib/lineage/server-fs";
import { buildMetadata } from "../../../lib/metadata";

/**
 * Ported from docs/<conf>/deep.html. Same client-page/server-layout
 * split as app/[conf]/lineage/layout.tsx. Only conferences that ship a
 * `deep-manifest.json` get this route (today: iclr-2026 only).
 */
export async function generateStaticParams(): Promise<{ conf: string }[]> {
  const slugs = await listConferenceSlugsWithFile("deep-manifest.json");
  return slugs.map((conf) => ({ conf }));
}

export async function generateMetadata({ params }: { params: Promise<{ conf: string }> }) {
  const { conf } = await params;
  const display = conferenceDisplayName(conf);
  return buildMetadata({
    path: `/${conf}/deep/`,
    title: `Deep Lineage — ${display} — PaperPilot`,
    description: `${display} の深掘り系譜。1 本の論文を中心に祖先・子孫の関係を確認します。品質監査に合格した関係だけを表示します。`,
  });
}

export default function ConferenceDeepLayout({ children }: { children: ReactNode }) {
  return children;
}
