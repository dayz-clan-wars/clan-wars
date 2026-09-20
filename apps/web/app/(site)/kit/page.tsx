import type { Metadata } from "next";
import { boosterKit } from "@factions/roster";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { currentSession } from "@/lib/viewer";
import { kitView } from "@/lib/kit-view";
import { SessionLost } from "@/app/components/ui";
import { KitFlow } from "./kit-flow";

export const metadata: Metadata = {
  title: "Clan Wars — your booster kit",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

/**
 * The booster kit page: nine picks, a spot marked in game, and the sequence
 * that marks it. Everything a player touches lives in kit-flow.tsx, which is
 * a client component; this is the one read that feeds it.
 *
 * ⚠️ The catalogue is handed over ONLY to a booster with a linked character,
 * which is the only state that renders a picker. It is 200 entries and it
 * would otherwise ride the payload of a page that, for a visitor deciding
 * whether to boost, is three item pictures and a link to Discord.
 *
 * ⚠️ Still reached through the `@factions/domain/catalogue` subpath, never
 * re-exported from the package index. See boosterCatalogue's own comment: the
 * index is in the browser graph, and the catalogue's weight lands in every
 * visitor's download the moment it is exported from there.
 */
export default async function KitPage() {
  const session = await currentSession();
  if (!session) return <SessionLost next="/kit" />;
  const view = kitView(await boosterKit(session.sub));
  const catalogue = view.boosting && view.gamertag !== null ? boosterCatalogue() : null;
  return <KitFlow initial={view} catalogue={catalogue} />;
}
