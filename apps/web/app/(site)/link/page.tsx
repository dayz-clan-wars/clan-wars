import type { Metadata } from "next";
import { linkStatus } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { Page, GuideLine, SessionLost, Notice } from "@/app/components/ui";
import { UNLINK_COPY } from "@/lib/link-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { guideLinkFor } from "@/lib/guide-links";
import { LinkFlow } from "./link-flow";

export const metadata: Metadata = {
  title: "Clan Wars — link your character",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function LinkPage({ searchParams }: { searchParams: Promise<{ unlink?: string }> }) {
  // ⚠️ Looked up, never echoed: ?unlink= is attacker-supplied (see lib/copy-lookup.ts).
  // An unlinked member's /me forwards here, so a successful unlink's notice lands on this page.
  const { unlink: unlinkCode } = await searchParams;
  const unlinkNotice = unlinkCode ? lookupCopy(UNLINK_COPY, unlinkCode) : undefined;
  const session = await currentSession();
  if (!session) {
    return <SessionLost next="/link" />;
  }
  const status = await linkStatus(session.sub);
  // Dates cross to the client as strings; the component parses them.
  return (
    <Page wide>
      <div className="px-5 pt-6 lg:px-8 lg:pt-8"><GuideLine guide={guideLinkFor("/link")} /></div>
      {unlinkNotice && <div className="px-5 pt-5 lg:px-8"><Notice>{unlinkNotice}</Notice></div>}
      <LinkFlow initial={JSON.parse(JSON.stringify(status))} />
    </Page>
  );
}
