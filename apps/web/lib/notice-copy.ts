import { FLAG_DOWN_MS, DORMANT_AFTER_MS, INTRUDER_PIN_TTL_MS, type ClanNoticeKind, type NoticeTarget } from "@factions/domain";
import type { NoticePayload } from "@factions/roster";

/**
 * The site's rendering of a clan notice: a kicker, a title, and a sentence.
 *
 * ⚠️ This is a SECOND renderer. apps/bot/src/notice-text.ts renders the same
 * kinds for Discord, and the two will drift. They are separate because the
 * formats genuinely differ — Discord gets `<@id>` mentions, `**bold**`, a
 * leading emoji and a bare URL, none of which belong on a web page, and the
 * page needs three fields where Discord needs one string. test/notice-copy.ts
 * pins the kind list; nothing can pin the wording, so read both when you
 * change either.
 *
 * ⚠️ A renderer reads only the keys its writer sets and invents none.
 * NoticePayload forbids nothing by name; the clan_notices_no_coordinates check
 * constraint is what keeps codes and coordinates out of the payload, and these
 * renderers are what keep them out of the page.
 */

export const NOTICE_GROUPS = ["Roster", "Raid", "Base", "Leadership", "Achievement", "Enforcement", "Dormancy", "Rebind"] as const;
export type NoticeGroup = (typeof NOTICE_GROUPS)[number];

export type NoticeCopy = {
  kicker: string;
  title: string;
  body: string;
  /**
   * Where this notice sends the reader, when there is somewhere to send them.
   *
   * ⚠️ Optional, and most kinds have none: a raid notice describes something
   * that already happened and has nowhere to go. A kind that asks the reader to
   * DO something needs one, or the notice is a dead end — the Discord DM for
   * `booster_kit_unchosen` carries a button and the site's copy of the same
   * notice carried nothing, which is how that one shipped.
   */
  cta?: { label: string; href: string };
};

/**
 * A payload's name slot, honestly. Missing renders as "someone" rather than a
 * gap; an all-digit value is a raw Discord id smuggled in as a fallback (see
 * `gamertagOrId` in the roster's feed-actor) and must never be printed as if
 * it were a gamertag.
 */
const who = (v: NoticePayload[string] | undefined): string => {
  if (v === null || v === undefined || v === "") return "someone";
  const s = String(v);
  return /^\d+$/u.test(s) ? "someone" : s;
};

/** A payload's clan-name slot. */
const clanOf = (v: NoticePayload[string] | undefined): string =>
  v === null || v === undefined || v === "" ? "your clan" : String(v);

/** A count, as a numeral, defaulting to a word rather than NaN. */
const count = (v: NoticePayload[string] | undefined): string => {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "some";
};

/**
 * "60 minutes" from the real constant, so this can never drift from rules.ts.
 * ⚠️ Never hand-type a duration this reads from a payload-independent rule —
 * that is exactly how the intruder copy said "24 hours" for a 60-minute TTL.
 */
const MINUTES = (ms: number): string => `${Math.round(ms / 60_000)} minutes`;
/** Same guarantee as `MINUTES`, in whole hours. */
const HOURS = (ms: number): string => `${Math.round(ms / 3_600_000)} hours`;
/** Same guarantee as `MINUTES`, in whole days. */
const DAYS = (ms: number): string => `${Math.round(ms / 86_400_000)} days`;

/** "3h 15m" from a count of seconds, matching the Discord renderer's `duration`. */
const forSeconds = (v: NoticePayload[string] | undefined): string => {
  const s = Number(v);
  if (!Number.isFinite(s) || s < 0) return "a while";
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `d MMM yyyy`, UTC, from a payload date/datetime string, matching the bot's
 * `formatDate`. An empty, missing or unparseable value falls back to `null`
 * rather than printing "Invalid Date" — callers give a plain sentence instead.
 */
const dateOf = (v: NoticePayload[string] | undefined): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** A renderer reads the payload and, where the fact differs by audience, the notice's own target. */
type Render = (p: NoticePayload, target: NoticeTarget) => NoticeCopy;

export const NOTICE_COPY: Record<ClanNoticeKind, { group: NoticeGroup; render: Render }> = {
  // ---- Roster ----
  invited: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `${clanOf(p.clan)} invited you`,
    body: "An officer invited you to join. Accept and you are pending until the log sees you at their base." }) },
  joined: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `${who(p.gamertag)} joined`,
    body: "Pending until the log sees them standing at the base." }) },
  became_full: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `${who(p.gamertag)} is a full member`,
    body: "Seen at the base, so they are on the roster now." }) },
  left: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `${who(p.gamertag)} left`, body: "They are off the roster." }) },
  // ⚠️ `kicked` is written to TWO targets with two different payloads (roster-store.ts):
  // the channel gets {gamertag, officer} and every member of the clan reads it, while the
  // DM gets {clan, until} and only the removed player reads it. A single string here would
  // tell the whole clan they were personally removed — branch on target, mirroring the
  // bot's notice-text.ts.
  kicked: { group: "Roster", render: (p, target) => target === "channel"
    ? { kicker: "Roster", title: `${who(p.gamertag)} was removed`, body: `Removed by ${who(p.officer)}.` }
    : { kicker: "Roster", title: `You were removed from ${clanOf(p.clan)}`,
        body: p.until ? `You can join a clan again on ${dateOf(p.until) ?? "a later date"}.` : "You can join another clan once the cooldown ends." } },
  promoted: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `${who(p.gamertag)} is now an officer`,
    body: `${who(p.gamertag)} can review join requests, send invites and rotate the codes.` }) },
  demoted: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `${who(p.gamertag)} is back to member`, body: "Officer powers removed." }) },
  request_accepted: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `${clanOf(p.clan)} accepted your request`,
    body: "Go and stand at their base to become a full member." }) },
  request_declined: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `${clanOf(p.clan)} declined your request`, body: "You can request another clan whenever you like." }) },
  pending_expired: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `Your spot in ${clanOf(p.clan)} expired`,
    body: "You were never seen at their base, so the pending place was released." }) },
  guest: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `${who(p.officer)} gave ${who(p.user)} a voice guest pass`,
    body: "It lapses on its own when the pass runs out." }) },
  renamed: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `You are now ${clanOf(p.name)}`,
    body: p.tag ? `The tag is ${String(p.tag)}.` : "The clan was renamed." }) },

  // ---- Leadership ----
  transferred: { group: "Leadership", render: (p) => ({
    kicker: "Leadership", title: `${who(p.gamertag)} is now leader`, body: `Handed over by ${who(p.old)}.` }) },
  leader_removed: { group: "Leadership", render: (p) => ({
    kicker: "Leadership", title: `${who(p.new)} is now leader`,
    body: `${who(p.old)} is no longer in the Discord, so leadership passed on.` }) },
  succession_claimed: { group: "Leadership", render: (p) => ({
    kicker: "Leadership", title: `${who(p.gamertag)} claimed leadership`,
    body: `${who(p.leader)} has to show up in game before the window closes, or the claim stands.` }) },
  succession_voided: { group: "Leadership", render: (p) => ({
    kicker: "Leadership", title: "The leadership claim is void",
    body: `${who(p.leader)} showed up in game, so ${who(p.claimant)}'s claim lapsed.` }) },
  succession_done: { group: "Leadership", render: (p) => ({
    kicker: "Leadership", title: `${who(p.gamertag)} is now leader`, body: "The succession went through." }) },
  vote_opened: { group: "Leadership", render: (p) => {
    const closes = dateOf(p.closesAt);
    return {
      kicker: "Leadership", title: "A no-confidence vote opened",
      body: `To replace ${who(p.leader)} with ${who(p.nominee)}. It closes ${closes ?? "when the window ends"} or once everyone has voted.`,
    };
  } },
  vote_passed: { group: "Leadership", render: (p) => ({
    kicker: "Leadership", title: `The vote passed, ${count(p.yes)} of ${count(p.n)}`,
    body: `${who(p.nominee)} is now leader. ${who(p.old)} stays on as an officer.` }) },
  vote_failed: { group: "Leadership", render: (p) => {
    const next = dateOf(p.date);
    return {
      kicker: "Leadership", title: `The vote failed, ${count(p.yes)} of ${count(p.n)}`,
      body: next ? `Leadership is unchanged. Another vote is possible on ${next}.` : "Leadership is unchanged.",
    };
  } },
  // ⚠️ `codes_rotated` is also written to two targets with different payloads
  // (vault-store.ts): the channel gets {gamertag}, the DM gets {clan, link}.
  // Both are true for both audiences ("the codes rotated, see the vault"), but
  // only the channel payload names who did it, so branch to say that where we can.
  codes_rotated: { group: "Leadership", render: (p, target) => ({
    kicker: "Codes", title: "Base codes rotated",
    body: target === "channel"
      ? `${who(p.gamertag)} rotated them. The new codes are in the vault. They are never shown here.`
      : "The new codes are in the vault and your clan channel. They are never shown here." }) },

  // ---- Raid ----
  flag_down: { group: "Raid", render: (p) => ({
    kicker: "Raid", title: "Your flag is down",
    body: `Lowered by ${who(p.gamertag)}${p.raiderClan ? ` of ${clanOf(p.raiderClan)}` : ""}. Raise it again within ${HOURS(FLAG_DOWN_MS)} or you go dormant. Your supply crate is paused until you do. A spare flag keeps spawning at your pole, so you always have one to raise.` }) },
  defended: { group: "Raid", render: (p) => ({
    kicker: "Defense", title: "Your base held",
    body: `${who(p.gamertag)} got the flag back up after ${forSeconds(p.durationSeconds)} under siege. Supplies resume at the next restart.` }) },

  // ---- Base ----
  intruder: { group: "Base", render: (p) => ({
    kicker: "Base", title: "Someone was inside your perimeter",
    body: `${who(p.gamertag)} is not on your roster and was logged ${count(p.distance)} m from your base. Their track is on the map for ${MINUTES(INTRUDER_PIN_TTL_MS)}.` }) },
  solo_intruder: { group: "Base", render: (p) => ({
    kicker: "Base", title: "Someone was inside your perimeter",
    body: `${who(p.gamertag)} was logged ${count(p.distance)} m from your base. Their track is on the map for ${MINUTES(INTRUDER_PIN_TTL_MS)}.` }) },
  dismantle: { group: "Base", render: (p) => ({
    kicker: "Base", title: "Something was dismantled at your base",
    body: `${who(p.gamertag)} took down ${p.part ? String(p.part) : "a part"} and is not on your roster.` }) },
  solo_dismantle: { group: "Base", render: (p) => ({
    kicker: "Base", title: "Something was dismantled at your base",
    body: `${who(p.gamertag)} took down ${p.part ? String(p.part) : "a part"}.` }) },
  gate_built: { group: "Base", render: (p) => ({
    kicker: "Base", title: "A gate went up at your base",
    body: `${who(p.gamertag)} built it and is not on your roster.` }) },
  solo_gate: { group: "Base", render: (p) => ({
    kicker: "Base", title: "A gate went up at your base",
    body: `${who(p.gamertag)} built it.` }) },
  built: { group: "Base", render: (p) => ({
    kicker: "Base", title: "Something was built at your base",
    body: `${who(p.gamertag)} put up ${p.part ? String(p.part) : "a structure"} and is not on your roster.` }) },
  solo_built: { group: "Base", render: (p) => ({
    kicker: "Base", title: "Something was built at your base",
    body: `${who(p.gamertag)} put up ${p.part ? String(p.part) : "a structure"}.` }) },
  non_member_raise: { group: "Base", render: (p) => ({
    kicker: "Base", title: "A non-member raised your flag",
    body: `${who(p.gamertag)} is not on your roster and raised the colours at your base.` }) },
  solo_non_member_raise: { group: "Base", render: (p) => ({
    kicker: "Base", title: "Someone raised your flag",
    body: `${who(p.gamertag)} raised the colours at your base.` }) },
  solo_lapsed: { group: "Base", render: () => ({
    kicker: "Base", title: "Your solo base lapsed",
    body: "The declaration expired without a raise. The pole is released, and anyone can claim it after the grace period, but you can also raise the flag there and declare again first." }) },
  colors_elsewhere: { group: "Base", render: (p) => ({
    kicker: "Base", title: "Your flag is flying somewhere else",
    body: `${who(p.gamertag)} raised it at a pole that is not yours.` }) },

  // ---- Rebind ----
  rebind_proposed: { group: "Rebind", render: (p) => ({
    kicker: "Rebind", title: "A move was proposed for your pole",
    body: `${who(p.gamertag)} raised your flag at a new pole. A leader has to confirm or refuse it before it lapses.` }) },
  rebind_confirmed: { group: "Rebind", render: () => ({
    kicker: "Rebind", title: "Your base moved",
    body: "Supplies follow at the next restart. The old pole goes public after the grace period." }) },

  // ---- Achievement ----
  // ⚠️ Also written to the clan channel (achievements/tick.ts), where the payload
  // carries `ownerKind`/`ownerName` (or `gamertag`) for the actual unlocker — reading
  // only name/description here tells every OTHER member the unlock was their own.
  achievement: { group: "Achievement", render: (p) => {
    const owner = p.ownerKind === "clan" ? clanOf(p.ownerName) : who(p.gamertag ?? p.ownerName);
    return {
      kicker: "Achievement", title: `Unlocked: ${p.name ? String(p.name) : "an achievement"}`,
      body: `${owner} unlocked it.${p.description ? ` ${String(p.description)}` : ""}`,
    };
  } },

  // ---- Enforcement ----
  zone_warning: { group: "Enforcement", render: (p) => {
    const acts = [
      Number(p.dismantled) > 0 ? `dismantling ${count(p.dismantled)}` : null,
      Number(p.built) > 0 ? `building ${count(p.built)}` : null,
      Number(p.stacked) > 0 ? `stacking ${count(p.stacked)}` : null,
    ].filter(Boolean).join(" and ");
    return {
      kicker: "Zone warning",
      title: "You were logged inside a declared base zone",
      // ⚠️ The "if they asked you to help, ignore this" line is load-bearing and
      // is in the Discord copy too: the log cannot tell an invited builder from
      // an intruder, and dropping it turns a warning into a false accusation.
      body: `The log recorded you ${acts || "acting"} inside ${p.tag ? String(p.tag) : "another clan"}'s zone. If they asked you to help, ignore this. If not, an officer can report it, and the penalty scales with the damage.`,
    };
  } },
  booster_kit_unchosen: { group: "Roster", render: () => ({
    kicker: "Booster kit", title: "You have a booster kit waiting",
    body: "Pick the nine pieces you respawn with, and the spot they wait at. Nothing is chosen yet, so nothing will spawn.",
    cta: { label: "Choose your kit", href: "/kit" } }) },
  award_granted: { group: "Roster", render: (p) => ({
    kicker: "Award",
    title: `You won ${p.label ? String(p.label) : "an award"}`,
    body: `${p.reason ? `${String(p.reason)}. ` : ""}Choose your gear and mark where it spawns${dateOf(p.placeBy) ? ` by ${dateOf(p.placeBy)}` : ""}. It respawns there every restart until the award runs out.`,
    // ⚠️ The grant id, never the payload's absolute URL: the page renders its
    // own links, and a bare URL in notice copy is banned (notice-copy.test).
    cta: { label: "Configure your award", href: typeof p.grantId === "number" ? `/awards/${p.grantId}` : "/awards" },
  }) },
  ban_applied: { group: "Enforcement", render: (p) => ({
    kicker: "Ban",
    title: p.until ? "You were banned from the server" : "You were permanently banned",
    body: p.until
      ? `Until ${dateOf(p.until) ?? "a later date"}. Reason: ${p.reason ? String(p.reason) : "a zone violation"}. It lifts on its own.`
      : `Reason: ${p.reason ? String(p.reason) : "repeated zone violations"}.`,
  }) },
  bounty_placed: { group: "Enforcement", render: (p) => ({
    kicker: "Bounty", title: "There is a bounty on you",
    body: `${p.reason ? `${String(p.reason)}. ` : ""}Until someone kills you, or you have played ${typeof p.hours === "number" ? `${p.hours} h` : "your time"} online, your position shows on everyone's map whenever you're online. Logging off takes you off the map, and does not run the clock.`,
    cta: { label: "See the map", href: "/map" } }) },
  bounty_expired: { group: "Enforcement", render: () => ({
    kicker: "Bounty", title: "Your bounty expired", body: "It expired unclaimed. You are off the map." }) },
  bounty_revoked: { group: "Enforcement", render: () => ({
    kicker: "Bounty", title: "Your bounty was lifted", body: "An admin lifted the bounty on you. You are off the map." }) },

  // ---- Dormancy ----
  dormant_raided: { group: "Dormancy", render: () => ({
    kicker: "Dormancy", title: "You went dormant",
    body: `${HOURS(FLAG_DOWN_MS)} passed with the flag down. Any member raising it brings you back.` }) },
  dormant_inactive: { group: "Dormancy", render: () => ({
    kicker: "Dormancy", title: "You went dormant",
    body: `No member has raised the flag in ${DAYS(DORMANT_AFTER_MS)}. Your supply crate stopped until someone does. A spare flag keeps spawning at your pole.` }) },
  revived: { group: "Dormancy", render: (p) => ({
    kicker: "Dormancy", title: "You are active again",
    body: p.gamertag ? `${who(p.gamertag)} raised the flag.` : "The flag went back up." }) },
  disband_warning: { group: "Dormancy", render: (p) => ({
    kicker: "Dormancy", title: `${count(p.days)} days from disbanding`,
    body: "One session from any full member resets the clock. After that the flag returns to the pool." }) },
};

/**
 * The rendered copy plus its group, for one notice.
 *
 * ⚠️ `kind` is read from `clan_notices`, not derived from `CLAN_NOTICE_KINDS` —
 * a kind retired from that list, an old row from before a retirement, or a bot
 * deployed ahead of this app can all hand this an entry `NOTICE_COPY` never had.
 * The stated goal here is that an unknown notice is never a reason to fail the
 * page (the layouts' bell has no error boundary of its own), so an unrecognised
 * kind gets an honest fallback instead of `entry.render` throwing a TypeError.
 * This is NOT the general-purpose fallback the spec (§4) rejects: every kind in
 * `CLAN_NOTICE_KINDS` still has to go through a real renderer, or
 * notice-copy.test.ts's exhaustiveness check fails — this path is unreachable
 * for any kind that test can see, by construction.
 */
export function noticeCopy(kind: ClanNoticeKind, payload: NoticePayload, target: NoticeTarget = "dm"): NoticeCopy & { group: NoticeGroup } {
  const entry: { group: NoticeGroup; render: Render } | undefined = NOTICE_COPY[kind];
  if (!entry) return { group: "Roster", kicker: "Notice", title: "Something happened", body: "This notice is from a version of the bot this page does not recognise yet." };
  return { ...entry.render(payload, target), group: entry.group };
}

export const noticeGroup = (kind: ClanNoticeKind): NoticeGroup => NOTICE_COPY[kind]?.group ?? "Roster";

/**
 * Every kind in one filter group, for the query (M8). Read off NOTICE_COPY so
 * a new kind joins its group's filter by being written there, and the chip and
 * the row's own group can never disagree.
 */
export function kindsInGroup(group: NoticeGroup): ClanNoticeKind[] {
  return (Object.keys(NOTICE_COPY) as ClanNoticeKind[]).filter((k) => NOTICE_COPY[k].group === group);
}
