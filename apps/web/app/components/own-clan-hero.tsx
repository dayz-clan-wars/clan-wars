import { scoreboard, type ClanView } from "@factions/roster";
import { flagImagePath } from "@/src/flag-images";
import { gridRef } from "@/lib/map-projection";
import { SegNav } from "./ui";
import { ClanHero, Lit } from "./clan-hero";

export type OwnClanTab = "clan" | "board" | "vault" | "settings";

/**
 * The hero every "your clan" page opens on — /clan and its Board, Vault and
 * Settings pages — so the tabs stay put as you move between them, with the
 * page you are on lit. The Map is not a tab: it is in the top bar already.
 * Vault needs a full member and Settings an officer, the same rules the
 * pages themselves enforce.
 */
export async function OwnClanHero({ view, current, guide }: { view: ClanView; current: OwnClanTab; guide?: { href: string; label: string } }) {
  const { clan, me, roster } = view;
  const officer = me.status === "full" && (me.role === "officer" || me.role === "leader");
  const full = roster.filter((r) => r.status === "full").length;
  // This season's standing: rank on the board and points. Unranked clans have no rank.
  const standing = (await scoreboard()).rows.find((r) => r.tag === clan.tag) ?? null;
  const tabs = [
    { label: "Clan", href: "/clan", current: current === "clan" },
    { label: "Board", href: "/clan/board", current: current === "board" },
    ...(me.status === "full" ? [{ label: "Vault", href: "/clan/vault", current: current === "vault" }] : []),
    ...(officer ? [{ label: "Settings", href: "/clan/settings", current: current === "settings" }] : []),
  ];
  return (
    <ClanHero
      flagSrc={`/${flagImagePath(clan.texture)}`}
      guide={guide}
      kicker={<>[{clan.tag}] · {clan.status} · you are {me.status === "pending" ? "pending" : me.role}{standing?.alpha && <> · <span className="text-gold">Alpha</span></>}</>}
      title={clan.name}
      facts={[
        ...(standing?.rank ? [<><Lit>#{standing.rank}</Lit> on the board</>] : []),
        <><Lit>{full}</Lit> members</>,
        ...(standing ? [<><Lit>{standing.points}</Lit> points</>] : []),
        ...(clan.base ? [<>Base at <Lit>{gridRef(clan.base.x, clan.base.z)}</Lit></>] : []),
      ]}
      aside={<SegNav label="Clan pages" items={tabs} className="bg-frame/90" />}
    />
  );
}
