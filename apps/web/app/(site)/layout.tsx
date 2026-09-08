import { currentSession } from "@/lib/viewer";
import { SiteBar } from "./site-bar";
import { buildIndex } from "@/app/guide/index";

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
  return (
    <>
      <SiteBar signedIn={session !== null} guideIndex={buildIndex()} />
      {children}
    </>
  );
}
