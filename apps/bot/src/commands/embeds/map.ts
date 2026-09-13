import { EmbedBuilder } from "discord.js";
import type { MapState } from "@factions/roster";
import { PIN_ICON_LABELS, when } from "@factions/copy";
import { budget } from "./budget.js";

const GOLD = 0xc8a34a;
const TITLE = "Pins";
const FOOTER_TEXT = "`/map unpin pin:` removes one. `/map view` opens the map.";

/**
 * `/map pins`.
 *
 * ⚠️ Reads `state.pins` and NOTHING else off `MapState`. The same object
 * carries `intruders` (other players' live positions), `publicBases` (other
 * clans' declared bases) and `clanmates` — every one of them a raid target,
 * every one of them drawn only by the site's own map under its own gate. A
 * field added here that touches any of them turns an ephemeral convenience
 * into a targeting service.
 *
 * The viewer's own clan's pin coordinates DO appear, in metres, on the same
 * footing as `baseEmbed`'s own-base coordinates: the reply is ephemeral and
 * the data is the viewer's own clan's.
 */
export function pinsEmbed(state: MapState, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(TITLE).setURL(`${siteBaseUrl}/map`).setFooter({ text: FOOTER_TEXT });
  if (state.pins.length === 0) return embed.setDescription("No pins. Drop one with `/map pin`.");

  const line = (p: MapState["pins"][number]) =>
    `• **#${p.id}** ${PIN_ICON_LABELS[p.icon]} — ${Math.round(p.x)}, ${Math.round(p.z)}`
    + (p.note ? ` · ${p.note}` : "") + ` · by ${p.by} · expires ${when(p.expiresAt)}`;

  budget(TITLE.length + FOOTER_TEXT.length).list(
    embed, `${state.pins.length} pin${state.pins.length === 1 ? "" : "s"}`,
    state.pins.map(line), (n) => `+${n} more — see the map.`,
  );
  return embed;
}
