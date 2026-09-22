import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { award } from "@factions/roster";
import { awardsCatalogue } from "@factions/domain/awards";
import { currentSession } from "@/lib/viewer";
import { awardPageView } from "@/lib/award-view";
import { SessionLost } from "@/app/components/ui";
import { AwardFlow } from "./award-flow";

export const metadata: Metadata = { title: "Clan Wars — your award", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * One award: pick each piece, mark the spot, watch it go live.
 *
 * ⚠️ `notFound()` for a grant that is not the viewer's, the same answer as a
 * missing one: `award()` filters by owner in its WHERE.
 */
export default async function AwardPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  const id = Number((await params).id);
  if (!session) return <SessionLost next={`/awards/${Number.isInteger(id) ? id : ""}`} />;
  if (!Number.isInteger(id) || id <= 0) notFound();
  const v = await award(session.sub, id);
  if (!v) notFound();
  const def = awardsCatalogue()[v.awardKey];
  if (!def) notFound();
  return <AwardFlow initial={awardPageView(v, new Date())} def={def} />;
}
