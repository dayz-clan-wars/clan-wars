import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";

/** One side of a kill: the name the log used, and the clan they were in at that instant, if any. */
export type KillFeedSide = { gamertag: string; tag: string | null; texture: string | null };

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
  /** `finished` for a credited kill (kills-tick: shot to near-zero and left to die); anything else reads as a plain kill. */
  cause: string;
  /** The running tally, counted up to and including this kill. */
  tally: { killerKills: number; victimDeaths: number; season: number | null };
  /** The killer's own hits on this victim in the RECENT_HIT_WINDOW_S before the kill, oldest first. May be empty. */
  hits: HitDetail[];
};

const RUST = 0xb0482a;
const AMBER = 0xe67e22;

/** Discord markdown in a gamertag would restyle the line; a name is text, never markup. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\*_~`|[\]()>]/gu, (c) => `\\${c}`);
}

export function profileUrl(siteBaseUrl: string, gamertag: string): string {
  return `${siteBaseUrl}/players/${encodeURIComponent(gamertag)}`;
}

/** `**[Name](profile)** [TAG]` — the name links to the profile; the tag is plain. */
export function who(side: KillFeedSide, siteBaseUrl: string): string {
  const name = `**[${escapeMarkdown(side.gamertag)}](${profileUrl(siteBaseUrl, side.gamertag)})**`;
  return side.tag ? `${name} [${escapeMarkdown(side.tag)}]` : name;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** `KA-74 · 41 m`, or whichever half the log gave. Empty when it gave neither. */
export function howLine(weapon: string | null, distanceM: number | null): string {
  const parts: string[] = [];
  if (weapon) parts.push(escapeMarkdown(weapon));
  if (distanceM !== null && Number.isFinite(distanceM)) parts.push(`${Math.round(distanceM)} m`);
  return parts.join(" · ");
}

/** One hit, as both feeds render it. No coordinates — damage, where, what with, how far. */
export type HitDetail = {
  damage: number | null;
  bodyPart: string | null;
  weapon: string | null;
  distanceM: number | null;
};

/**
 * ⚠️ Ten, not Discord's 4096-character description limit. A sustained
 * firefight stops being readable long before it stops being legal.
 */
export const DETAIL_LINE_CAP = 10;

/**
 * `38 dmg · Torso · KA-74 · 41 m`, dropping whatever the log did not give.
 *
 * The weapon is omitted by default because #hit-feed's engagements are keyed
 * on one weapon and already name it in the header; a kill run can switch
 * weapons, so the kill feed passes `{ weapon: true }`.
 */
export function detailLine(d: HitDetail, opts: { weapon?: boolean } = {}): string {
  const parts: string[] = [];
  if (d.damage !== null && Number.isFinite(d.damage)) parts.push(`${Math.round(d.damage)} dmg`);
  if (d.bodyPart) parts.push(escapeMarkdown(d.bodyPart));
  if (opts.weapon && d.weapon) parts.push(escapeMarkdown(d.weapon));
  if (d.distanceM !== null && Number.isFinite(d.distanceM)) parts.push(`${Math.round(d.distanceM)} m`);
  return parts.join(" · ");
}

/** The first `DETAIL_LINE_CAP` lines, plus `… and N more` when there were more. */
export function cappedLines(lines: string[], noun: string): string[] {
  if (lines.length <= DETAIL_LINE_CAP) return lines;
  const extra = lines.length - DETAIL_LINE_CAP;
  return [...lines.slice(0, DETAIL_LINE_CAP), `… and ${extra} more ${noun}`];
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
  const killerTag = k.killer.tag ? ` [${escapeMarkdown(k.killer.tag)}]` : "";
  const how = howLine(k.weapon, k.distanceM);
  const scope = k.tally.season === null ? "all-time" : "this season";
  const verb = k.cause === "finished" ? "finished" : "killed";
  const lines = [
    k.friendlyFire
      ? `${verb} their own clanmate ${who(k.victim, siteBaseUrl)}`
      : `${verb} ${who(k.victim, siteBaseUrl)}`,
    ...(how ? [how] : []),
    `${plural(k.tally.killerKills, "kill")} for ${escapeMarkdown(k.killer.gamertag)} · ` +
      `${plural(k.tally.victimDeaths, "death")} for ${escapeMarkdown(k.victim.gamertag)} ${scope}`,
  ];

  const detail = cappedLines(k.hits.map((h) => detailLine(h, { weapon: true })).filter((l) => l !== ""), "hits");
  if (detail.length > 0) lines.push("", ...detail);

  return {
    title: `${k.friendlyFire ? "Friendly fire — " : ""}${k.killer.gamertag}${killerTag}`,
    url: profileUrl(siteBaseUrl, k.killer.gamertag),
    description: lines.join("\n"),
    color: k.friendlyFire ? AMBER : RUST,
    footer: { text: k.tally.season === null ? "All-time" : `Season ${k.tally.season}` },
    // ⚠️ The kill's time, not the post's: a delayed post still reads as when it happened.
    timestamp: k.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(k.killer.texture ? { fields: [{ name: "Flag", value: flagLabel(k.killer.texture), inline: true }] } : {}),
  };
}
