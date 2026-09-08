import type { Metadata } from "next";
import { mapState } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/map-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import MapView from "./map-view";
import { guideLinkFor } from "@/lib/guide-links";
import { GUIDE_INLINE, guideLink } from "@/lib/guide-links";
import { link } from "@/app/components/ui";

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
    return <main className="mx-auto max-w-[34rem] px-4 py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/map">Sign in again</a>.</p></main>;
  }
  // ⚠️ Only the entitlement is read here. The positions themselves come from
  // /api/map/state in the browser, so the server-rendered HTML carries no
  // coordinate and the page cannot bake one into a static chunk.
  const state = await mapState(session.sub);
  if (state === "not-linked") {
    return (
      <main className="mx-auto max-w-[34rem] px-4 py-10">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">The map</p>
        <p className="mt-6 text-ink-2"><a className={link} href="/link">Link your character</a> first — the map is behind login and a linked character. Nobody sees it without both. <a className={link} href={guideLink(GUIDE_INLINE.gettingIn).href}>How linking works</a>.</p>
      </main>
    );
  }
  return <MapView layers={state.layers} notice={notice} guide={guideLinkFor("/map")} />;
}
