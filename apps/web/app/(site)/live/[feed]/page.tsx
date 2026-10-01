import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { onlineNow } from "@factions/roster";
import { isLiveFeed } from "@factions/domain";
import { Page, PageHead, Body, Panel, PanelBody, SegNav } from "@/app/components/ui";
import { LIVE_TABS, loadLive, parseCursor } from "@/lib/live";
import { LiveList } from "../live-list";
import { OnlineBoard } from "../online-board";

export const metadata: Metadata = { title: "Clan Wars — live" };
/** ⚠️ Public but live: rendered per request, never baked into a static chunk. */
export const dynamic = "force-dynamic";

export default async function LivePage({ params, searchParams }: { params: Promise<{ feed: string }>; searchParams: Promise<{ before?: string | string[] }> }) {
  const { feed } = await params;
  // ⚠️ Attacker-supplied: anything but a known feed is a 404, before any read.
  if (!isLiveFeed(feed)) notFound();
  const tab = LIVE_TABS.find((t) => t.feed === feed)!;
  // SegNav wraps at phone width rather than scrolling: nine short labels fit in a few rows.
  const nav = <SegNav label="Feed" items={LIVE_TABS.map((t) => ({ label: t.label, href: `/live/${t.feed}`, current: t.feed === feed }))} />;

  if (feed === "online") {
    const players = (await onlineNow()).map((p) => ({ ...p, connectedAt: p.connectedAt.toISOString() }));
    return (
      <Page wide>
        <PageHead kicker="Live" title={tab.label} aside={nav} />
        <Body><Panel><PanelBody><OnlineBoard initial={players} /></PanelBody></Panel></Body>
      </Page>
    );
  }

  const before = parseCursor((await searchParams).before);
  const items = await loadLive(feed, { before });
  return (
    <Page wide>
      <PageHead kicker="Live" title={tab.label} aside={nav} />
      <Body>
        <Panel>
          <PanelBody>
            <LiveList feed={feed} initial={items} live={before === undefined} />
          </PanelBody>
        </Panel>
      </Body>
    </Page>
  );
}
