import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";

// Moved to site-links.ts. Re-exported so the five modules that import them
// from here keep working; prefer importing from site-links.ts in new code.
export { escapeMarkdown, profileUrl, who } from "./site-links.js";
import { DETAIL_LINE_CAP, howLine as copyHowLine, killCard } from "@factions/copy";
import { lineMarkdown } from "./site-links.js";
import { toLiveKill } from "./live-payload.js";

/** One side of a kill: the name the log used, and the clan they were in at that instant, if any. */
export type KillFeedSide = { gamertag: string; tag: string | null; texture: string | null };

/**
 * The side a store hands back for an item it already knows the render will
 * decline — the name/tag/flag lookups are skipped, so something has to stand
 * in. One constant for every feed, because three copies of one fact drift
 * (see CLAUDE.md), and these already had.
 *
 * ⚠️ A word, never `""`. If a feed ever stops declining the items it fills in
 * with this, an empty gamertag makes an empty embed title, Discord answers
 * 400, `cursorFeedTick` reads that as a post failure, and the feed wedges
 * with a "blocked at" line pointing at the wrong cause.
 */
export const UNKNOWN_SIDE: KillFeedSide = { gamertag: "Unknown", tag: null, texture: null };

/** One kill, ready to render. Built by `PgKillFeedStore`; never carries a position. */
export type KillFeedItem = {
  /** The kill's `events.id`: the feed's cursor. */
  eventId: number;
  occurredAt: Date;
  killer: KillFeedSide;
  victim: KillFeedSide;
  weapon: string | null;
  distanceM: number | null;
  friendlyFire: boolean;
  /** At the Fast Travel Hub: posted as a record, scores nowhere (spec 2026-09-22-hub-combat). */
  atHub: boolean;
  /** `finished` for a credited kill (kills-tick: shot to near-zero and left to die); anything else reads as a plain kill. */
  cause: string;
  /** The running tally, counted up to and including this kill. */
  tally: { killerKills: number; victimDeaths: number; season: number | null };
  /** The killer's own hits on this victim in the RECENT_HIT_WINDOW_S before the kill, oldest first. May be empty. */
  hits: HitDetail[];
};

const RUST = 0xb0482a;
const AMBER = 0xe67e22;

/** One hit, as both feeds render it. No coordinates — damage, where, what with, how far. */
export type HitDetail = {
  damage: number | null;
  bodyPart: string | null;
  weapon: string | null;
  distanceM: number | null;
};

// Re-exported so the cap the bot trims to is the one the website trims to.
export { DETAIL_LINE_CAP };

// Thin wrappers over the shared copy, kept for tests that pin their old string
// shape (nothing else in apps/bot/src imports them).
export function howLine(weapon: string | null, distanceM: number | null): string {
  return lineMarkdown(copyHowLine(weapon, distanceM), "");
}

/**
 * One kill, one embed. Pure — no client, no I/O, no clock.
 *
 * Rust for a kill; amber, and said in the title, for friendly fire. The
 * killer's clan flag is the thumbnail. Both names link to their profiles.
 * The footer names the season the tally counts in.
 */
export function killFeedEmbed(k: KillFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = k.killer.texture ? flagImage(k.killer.texture) : null;
  const card = killCard(toLiveKill(k));
  const lines = card.lines.map((l) => lineMarkdown(l, siteBaseUrl));
  if (card.detail.length > 0) lines.push("", ...card.detail.map((l) => lineMarkdown(l, siteBaseUrl)));

  return {
    title: lineMarkdown(card.title, siteBaseUrl),
    url: `${siteBaseUrl}${card.href}`,
    description: lines.join("\n"),
    color: k.atHub || k.friendlyFire ? AMBER : RUST,
    footer: { text: k.tally.season === null ? "All-time" : `Season ${k.tally.season}` },
    // ⚠️ The kill's time, not the post's: a delayed post still reads as when it happened.
    timestamp: k.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(k.killer.texture ? { fields: [{ name: "Flag", value: flagLabel(k.killer.texture), inline: true }] } : {}),
  };
}
