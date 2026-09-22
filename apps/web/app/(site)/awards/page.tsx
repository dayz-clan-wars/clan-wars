import type { Metadata } from "next";
import { awards } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { STATE_COPY } from "@/lib/award-copy";
import { Page, PageHead, Body, SessionLost, link } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — your awards", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

/** Every award the viewer has won, newest first, ended ones included with the reason they ended. */
export default async function AwardsPage() {
  const session = await currentSession();
  if (!session) return <SessionLost next="/awards" />;
  const list = await awards(session.sub);
  return (
    <Page>
      <PageHead kicker="Event awards" title="Your awards" />
      <Body>
        {list.length === 0
          ? <p className="text-sm text-ink-2">You have not won an award yet. Winners of community events get one.</p>
          : (
            <ul className="flex flex-col gap-3">
              {list.map((a) => (
                <li key={a.id} className="border border-rule-2 bg-frame p-3.5">
                  <a className={link} href={`/awards/${a.id}`}>{a.label}</a>
                  <div className="mt-1 text-xs text-ink-2">{a.reason}</div>
                  <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{STATE_COPY[a.state].title}</div>
                </li>
              ))}
            </ul>
          )}
      </Body>
    </Page>
  );
}
