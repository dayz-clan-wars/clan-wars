import type { Metadata } from "next";
import { mapState, claimContext } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/map-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import MapView, { type MapNext } from "./map-view";
import { guideLinkFor } from "@/lib/guide-links";
import { GUIDE_INLINE, guideLink } from "@/lib/guide-links";
import { link, Page, PageHead, Body, SessionLost } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — the map", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function MapPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  // ⚠️ Looked up, never echoed: ?result= is attacker-supplied, including
  // prototype keys like `__proto__`.
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const session = await currentSession();
  if (!session) {
    return <SessionLost next="/map" />;
  }
  // ⚠️ Only the entitlement is read here. The positions themselves come from
  // /api/map/state in the browser, so the server-rendered HTML carries no
  // coordinate and the page cannot bake one into a static chunk.
  const state = await mapState(session.sub);
  if (state === "not-linked") {
    return (
      <Page>
        <PageHead guide={guideLinkFor("/map")} kicker="The map" title="Not linked" />
        <Body className="max-w-[40rem]">
          <p className="text-ink-2"><a className={link} href="/link">Link your character</a> first — the map is behind login and a linked character. Nobody sees it without both. <a className={link} href={guideLink(GUIDE_INLINE.gettingIn).href}>How linking works</a>.</p>
        </Body>
      </Page>
    );
  }
  // The bar's last slot is the next step (App Review §03): found the waiting
  // clan → declare a base (solo, none declared) → your base (solo) → your clan.
  const ceremony = state.layers.clanmates ? null : await claimContext(session.sub);
  const next: MapNext = ceremony ? { label: "Found a clan", href: `/claim/${ceremony.ceremony.id}` }
    : state.layers.clanmates ? { label: "Your clan", href: "/clan" }
    : state.layers.base ? { label: "Your base", href: "/base" }
    : { label: "Declare base", href: "/base" };
  return <MapView layers={state.layers} notice={notice} guide={guideLinkFor("/map")} next={next} />;
}
