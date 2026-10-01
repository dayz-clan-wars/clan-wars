import type { APIEmbed } from "discord.js";
import type { FactionEventKind } from "@factions/domain";
import type { QueuedFactionEvent, FeedPayload } from "@factions/roster/internal";
import { clanFeedCard, flagLabel } from "@factions/copy";
import { lineMarkdown } from "./site-links.js";
// ⚠️ Imported, not a second literal here — this file is scanned by
// vocabulary.test.ts's PLAYER_FACING walk, whose comment-stripper treats a
// bare `//` inside a hardcoded "https://…" string as a line comment and
// corrupts the rest of the file's string literals. See config.ts.
import { DEFAULT_SITE_BASE_URL } from "./config.js";

/**
 * Where a flag's artwork lives, if it lives anywhere.
 *
 * ⚠️ Defaulted to null, and that is deliberate: the 33 textures are strings
 * in `packages/domain/src/flags.ts` and no images of them exist anywhere in
 * this repository. Sourcing, licensing and hosting them is its own piece of
 * work the feed does not need. This hook is so adding them later is one
 * function rather than a rewrite.
 */
export type FlagImageResolver = (texture: string) => string | null;

const NO_IMAGE: FlagImageResolver = () => null;

const GREEN = 0x3ba55d;
const BLUE = 0x5865f2;
const AMBER = 0xe67e22;
const RED = 0xed4245;

const COLOR: Record<FactionEventKind, number> = {
  founded: GREEN, activated: GREEN, revived: GREEN,
  renamed: BLUE, rebound: BLUE,
  dormant: AMBER, lapsed: AMBER,
  disbanded: RED,
};

// Other bot files import flagLabel from here.
export { flagLabel };

/**
 * One transition, one embed. Pure — no client, no I/O, no clock.
 *
 * ⚠️ Reads named payload fields only, never spreads the payload. Combined
 * with `faction_events_no_coordinates`, that is two independent reasons a
 * coordinate cannot reach a channel.
 */
export function feedEmbed(
  e: QueuedFactionEvent,
  flagImage: FlagImageResolver = NO_IMAGE,
  siteBaseUrl: string = DEFAULT_SITE_BASE_URL,
): APIEmbed {
  const p = e.payload;
  const image = flagImage(p.texture);
  const card = clanFeedCard(e.kind, p);

  return {
    title: lineMarkdown(card.title, siteBaseUrl),
    // ⚠️ BARE url — this is embed.url, which throws on `<https://…>`.
    url: `${siteBaseUrl}${card.href}`,
    description: lineMarkdown(card.lines[0]!, siteBaseUrl),
    color: COLOR[e.kind],
    fields: [{ name: "Flag", value: flagLabel(p.texture), inline: true }],
    // ⚠️ The transition's time, not the post's. A backfilled founding then
    // renders as history with no special-casing anywhere in the tick.
    timestamp: e.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
  };
}
