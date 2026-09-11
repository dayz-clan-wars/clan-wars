import { currentSession } from "@/lib/viewer";
import { attention, liveServers } from "@factions/roster";
import { SiteBar } from "./site-bar";
import { buildIndex } from "@/app/guide/index";
import { InstallStrip } from "@/app/components/install-strip";
import { ServerStrip } from "@/app/components/server-strip";
import { serverStripLines } from "@/lib/server-strip";
import { SkipLink } from "@/app/components/ui";

/**
 * The site shell: one top bar with the menu, over every page except the
 * landing page and the guide (which are static and live outside this group
 * on purpose — test/menu.test.ts pins that).
 *
 * ⚠️ Reading the session here makes every page in the group request-time
 * rendered. They all were already (public boards are live; the rest are
 * gated), so this costs nothing new — but it is why `/` and `/guide` must
 * never be moved in. See lib/viewer.ts.
 */
export const dynamic = "force-dynamic";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  // The bar's two counts (App Review §01): a handful of lookups, and never a
  // reason to fail the page — an unreachable count is a bar with no badge.
  const counts = session ? await attention(session.sub).catch(() => undefined) : undefined;
  // The server-name strip: one cheap read, and like the counts never a
  // reason to fail the page — unreachable means no strip.
  const serverLines = serverStripLines(await liveServers().catch(() => []));
  return (
    <>
      <SkipLink />
      <SiteBar signedIn={session !== null} guideIndex={buildIndex()} counts={counts} />
      <ServerStrip lines={serverLines} />
      <InstallStrip />
      {children}
    </>
  );
}
