import type { ClanNoticeKind } from "@factions/domain";
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

export type NoticeCopy = { kicker: string; title: string; body: string };

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

export const NOTICE_COPY: Record<ClanNoticeKind, { group: NoticeGroup; render: (p: NoticePayload) => NoticeCopy }> = {
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
  kicked: { group: "Roster", render: (p) => ({
    kicker: "Roster", title: `You were removed from ${clanOf(p.clan)}`,
    body: p.until ? `You can join a clan again on ${String(p.until).slice(0, 10)}.` : "You can join another clan once the cooldown ends." }) },
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
  vote_opened: { group: "Leadership", render: (p) => ({
    kicker: "Leadership", title: "A no-confidence vote opened",
    body: `To replace ${who(p.leader)} with ${who(p.nominee)}. It closes when the window ends or everyone has voted.` }) },
  vote_passed: { group: "Leadership", render: (p) => ({
    kicker: "Leadership", title: `The vote passed, ${count(p.yes)} of ${count(p.n)}`,
    body: `${who(p.nominee)} is now leader. ${who(p.old)} stays on as an officer.` }) },
  vote_failed: { group: "Leadership", render: (p) => ({
    kicker: "Leadership", title: `The vote failed, ${count(p.yes)} of ${count(p.n)}`, body: "Leadership is unchanged." }) },
  codes_rotated: { group: "Leadership", render: () => ({
    kicker: "Codes", title: "Base codes rotated",
    body: "The new codes are in the vault and your clan channel. They are never shown here." }) },

  // ---- Raid ----
  flag_down: { group: "Raid", render: (p) => ({
    kicker: "Raid", title: "Your flag is down",
    body: `Lowered by ${who(p.gamertag)}${p.raiderClan ? ` of ${clanOf(p.raiderClan)}` : ""}. Raise it again within 24 hours or you go dormant. Supplies are paused until you do.` }) },
  defended: { group: "Raid", render: (p) => ({
    kicker: "Defense", title: "Your base held",
    body: `${who(p.gamertag)} got the flag back up. The defense is on the war log and it scores this week.` }) },

  // ---- Base ----
  intruder: { group: "Base", render: (p) => ({
    kicker: "Base", title: "Someone was inside your perimeter",
    body: `${who(p.gamertag)} is not on your roster and was logged ${count(p.distance)} m from your base. Their track is on the map for 24 hours.` }) },
  solo_intruder: { group: "Base", render: (p) => ({
    kicker: "Base", title: "Someone was inside your perimeter",
    body: `${who(p.gamertag)} was logged ${count(p.distance)} m from your base. Their track is on the map for 24 hours.` }) },
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
    body: "The declaration expired without a raise. The pole is released, and anyone can claim it after the grace period." }) },
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
  achievement: { group: "Achievement", render: (p) => ({
    kicker: "Achievement", title: `Unlocked: ${p.name ? String(p.name) : "an achievement"}`,
    body: p.description ? String(p.description) : "It is on your wall now." }) },

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
  ban_applied: { group: "Enforcement", render: (p) => ({
    kicker: "Ban",
    title: p.until ? "You were banned from the server" : "You were permanently banned",
    body: p.until
      ? `Until ${String(p.until)}. Reason: ${p.reason ? String(p.reason) : "a zone violation"}. It lifts on its own.`
      : `Reason: ${p.reason ? String(p.reason) : "repeated zone violations"}.`,
  }) },

  // ---- Dormancy ----
  dormant_raided: { group: "Dormancy", render: () => ({
    kicker: "Dormancy", title: "You went dormant",
    body: "Twenty four hours passed with the flag down. Any member raising it brings you back." }) },
  dormant_inactive: { group: "Dormancy", render: () => ({
    kicker: "Dormancy", title: "You went dormant",
    body: "No member has raised the flag in seven days. Supplies stopped until someone does." }) },
  revived: { group: "Dormancy", render: (p) => ({
    kicker: "Dormancy", title: "You are active again",
    body: p.gamertag ? `${who(p.gamertag)} raised the flag.` : "The flag went back up." }) },
  disband_warning: { group: "Dormancy", render: (p) => ({
    kicker: "Dormancy", title: `${count(p.days)} days from disbanding`,
    body: "One session from any full member resets the clock. After that the flag returns to the pool." }) },
};

/** The rendered copy plus its group, for one notice. */
export function noticeCopy(kind: ClanNoticeKind, payload: NoticePayload): NoticeCopy & { group: NoticeGroup } {
  const entry = NOTICE_COPY[kind];
  return { ...entry.render(payload), group: entry.group };
}

export const noticeGroup = (kind: ClanNoticeKind): NoticeGroup => NOTICE_COPY[kind].group;
