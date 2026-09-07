import { RELEASED_POLE_GRACE_MS, SOLO_LAPSE_MS, SUCCESSION_WINDOW_MS } from "@factions/domain";
import type { ClanNoticeKind, NoticeTarget } from "@factions/domain";
import type { NoticePayload } from "@factions/roster/internal";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** Whole days a millisecond window spans, rounded — the numeral a sentence names. */
function days(ms: number): number {
  return Math.round(ms / DAY_MS);
}

/** Whole hours a millisecond window spans, rounded — the numeral a sentence names. */
function hours(ms: number): number {
  return Math.round(ms / HOUR_MS);
}

/** "6 min ago", "2 h ago", "3 d ago" — never a coordinate, never an exact clock time. */
export function relativeAge(at: Date, now: Date): string {
  const diffMs = now.getTime() - at.getTime();
  const minutes = Math.round(diffMs / MIN_MS);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(diffMs / HOUR_MS);
  if (hours < 24) return `${hours} h ago`;
  const d = Math.round(diffMs / DAY_MS);
  return `${d} d ago`;
}

/** "3h 15m" from a count of seconds. */
export function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `d MMM yyyy`, UTC, from an ISO 8601 string — e.g. "8 Sep 2026". */
function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `formatDate` extended with the hour, UTC — e.g. "8 Sep 2026 14:00 UTC". */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(iso)} ${hh}:${mm} UTC`;
}

/**
 * A payload's gamertag slot, honestly. A missing name renders as `someone`
 * rather than "undefined" or an empty gap; an all-digit value is a raw
 * Discord id smuggled in as a fallback (see `gamertagOrId` in
 * `packages/roster/src/internal/feed-actor.ts`) and renders as a mention
 * rather than a meaningless number.
 */
function person(v: NoticePayload[string] | undefined): string {
  if (v === null || v === undefined || v === "") return "someone";
  const s = String(v);
  return /^\d+$/u.test(s) ? `<@${s}>` : s;
}

type RendererCtx = { target: NoticeTarget; age: string };
type Renderer = (p: NoticePayload, ctx: RendererCtx) => string;

/**
 * One arrow function per `ClanNoticeKind`, reading only the named keys its
 * writer actually put in the payload (see the task-7 report for the table).
 * `notice-text.test.ts`'s exhaustiveness check pins this to exactly
 * `CLAN_NOTICE_KINDS` — no more, no less (spec §13).
 */
export const RENDERERS: Record<ClanNoticeKind, Renderer> = {
  flag_down: (p) => {
    const of = p.raiderClan ? ` of ${p.raiderClan}` : "";
    return `🚨 Your flag is down — lowered by ${person(p.gamertag)}${of}. Re-raise within 24h or go dormant. Supplies paused.`;
  },
  defended: (p) => `🛡️ ${person(p.gamertag)} raised the flag. Defended — ${duration(Number(p.durationSeconds))} under siege. Supplies resume at next restart.`,
  dormant_raided: () => "💤 24 hours passed. You're dormant. Any member raising the flag brings you back.",
  dormant_inactive: () => "💤 No member has raised the flag in 7 days. You're dormant. Supplies stopped.",
  revived: (p) => (p.gamertag ? `☀️ ${person(p.gamertag)} raised the flag. You're active again.` : "☀️ The flag was raised. You're active again."),
  disband_warning: (p) => `⚠️ ${p.days} days until this clan is disbanded and the flag returns to the pool.`,
  non_member_raise: (p, ctx) => `⚑ ${person(p.gamertag)} (not a member) raised your flag at your base — ${ctx.age}`,
  colors_elsewhere: (p) => `🏴 Your flag is flying at a pole that isn't yours — raised by ${person(p.gamertag)}`,
  rebind_proposed: (p) => `📦 ${person(p.gamertag)} raised our flag at a new pole. Leader: confirm the move within 24h: ${p.link}`,
  rebind_confirmed: () => `📦 Moved. Supplies follow at the next restart. The old base goes public in ${days(RELEASED_POLE_GRACE_MS)} days.`,
  joined: (p) => `➕ ${person(p.gamertag)} joined — pending until seen at the base`,
  became_full: (p) => `✅ ${person(p.gamertag)} is now a full member (seen at the base)`,
  left: (p) => `➖ ${person(p.gamertag)} left`,
  kicked: (p, ctx) =>
    ctx.target === "channel"
      ? `🥾 ${person(p.gamertag)} was kicked by ${person(p.officer)}`
      : `You were removed from **${p.clan}**. You can join a clan again on ${formatDate(String(p.until))}.`,
  promoted: (p) => `⬆️ ${person(p.gamertag)} promoted to officer`,
  demoted: (p) => `⬇️ ${person(p.gamertag)} demoted to member`,
  transferred: (p) => `👑 ${person(p.gamertag)} is now leader (transferred by ${person(p.old)})`,
  renamed: (p) => `✏️ We are now **${p.name}** [${p.tag}].`,
  invited: (p) => `**${p.clan}** invited you. Accept or decline: ${p.link}`,
  request_accepted: (p) => `**${p.clan}** accepted your request. Go stand at the base to become a full member.`,
  request_declined: (p) => `**${p.clan}** declined your request.`,
  pending_expired: (p) => `Your spot in **${p.clan}** expired — you were never seen at the base.`,
  solo_non_member_raise: (p, ctx) => `⚑ ${person(p.gamertag)} (not a member) raised your flag at your base — ${ctx.age}`,
  solo_lapsed: (p) => `Your base declaration lapsed — no raise in ${days(SOLO_LAPSE_MS)} days. The pole goes public in ${days(RELEASED_POLE_GRACE_MS)} days unless you raise there and declare again: ${p.link}`,
  intruder: (p, ctx) => `👁 ${person(p.gamertag)} (not a member) was seen ${p.distance} m from your base — ${ctx.age}`,
  dismantle: (p, ctx) => `🔧 ${person(p.gamertag)} (not a member) dismantled ${p.part} at your base — ${ctx.age}`,
  gate_built: (p, ctx) => `🔧 ${person(p.gamertag)} (not a member) built a gate at your base — ${ctx.age}`,
  solo_intruder: (p, ctx) => `👁 ${person(p.gamertag)} (not a member) was seen ${p.distance} m from your base — ${ctx.age}`,
  solo_dismantle: (p, ctx) => `🔧 ${person(p.gamertag)} (not a member) dismantled ${p.part} at your base — ${ctx.age}`,
  solo_gate: (p, ctx) => `🔧 ${person(p.gamertag)} (not a member) built a gate at your base — ${ctx.age}`,
  leader_removed: (p) => `👑 ${person(p.old)} is no longer in the Discord. ${person(p.new)} is now leader.`,
  succession_claimed: (p) => `⏳ ${person(p.gamertag)} has claimed leadership — ${person(p.leader)} has ${hours(SUCCESSION_WINDOW_MS)}h to show up in game`,
  succession_voided: (p) => `⏳ ${person(p.leader)} showed up in game. The claim by ${person(p.claimant)} is void.`,
  succession_done: (p) => `👑 ${person(p.gamertag)} is now leader (succession)`,
  vote_opened: (p) => `🗳️ Vote opened: replace ${person(p.leader)} with ${person(p.nominee)}. Closes ${formatDateTime(String(p.closesAt))}. Vote on the site: ${p.link}`,
  vote_passed: (p) => `🗳️ Vote passed (${p.yes}/${p.n}). ${person(p.nominee)} is now leader; ${person(p.old)} stays as officer.`,
  vote_failed: (p) => `🗳️ Vote failed (${p.yes}/${p.n}). Next vote possible ${formatDate(String(p.date))}.`,
  codes_rotated: (p, ctx) =>
    ctx.target === "channel"
      ? `🔐 Codes rotated by ${person(p.gamertag)} — see the vault.`
      : `**${p.clan}** rotated its codes. See the vault: ${p.link}`,
  guest: (p) => `🎟️ ${person(p.officer)} gave ${person(p.user)} a 24h voice guest pass.`,
};

/** `RENDERERS[n.kind]`, fed the age computed from `occurredAt` and `now`. */
export function noticeText(n: { kind: ClanNoticeKind; target: NoticeTarget; occurredAt: Date; payload: NoticePayload }, now: Date): string {
  return RENDERERS[n.kind](n.payload, { target: n.target, age: relativeAge(n.occurredAt, now) });
}
