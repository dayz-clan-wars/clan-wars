import type { Metadata } from "next";
import { linkStatus } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { Page, GuideLine, SessionLost } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";
import { LinkFlow } from "./link-flow";

export const metadata: Metadata = {
  title: "Clan Wars — link your character",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function LinkPage() {
  const session = await currentSession();
  if (!session) {
    return <SessionLost next="/link" />;
  }
  const status = await linkStatus(session.sub);
  // Dates cross to the client as strings; the component parses them.
  return (
    <Page wide>
      <div className="px-5 pt-6 lg:px-8 lg:pt-8"><GuideLine guide={guideLinkFor("/link")} /></div>
      <LinkFlow initial={JSON.parse(JSON.stringify(status))} />
    </Page>
  );
}
