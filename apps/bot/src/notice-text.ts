import { RELEASED_POLE_GRACE_MS, SOLO_LAPSE_MS, SUCCESSION_WINDOW_MS, GUEST_PASS_MS, RAID_DEDUP_MS, REBIND_CONFIRM_MS } from "@factions/domain";
import type { ClanNoticeKind, NoticeTarget } from "@factions/domain";
import type { NoticePayload } from "@factions/roster/internal";
import { rel, at, atRel } from "@factions/copy";
import { playerLink, clanLink } from "./site-links.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Whole days a millisecond window spans, rounded — the numeral a sentence names. */
function days(ms: number): number {
  return Math.round(ms / DAY_MS);
}

/** Whole hours a millisecond window spans, rounded — the numeral a sentence names. */
function hours(ms: number): number {
  return Math.round(ms / HOUR_MS);
}

/**
 * "7 days" / "18 hours" — mirrors `dormancy-notify.ts`'s `formatDuration` so
 * the DM and this channel notice can never name two different numbers for
 * the same window. Staging can set `BOT_DORMANT_AFTER_MS` under a day;
 * `Math.round(ms / DAY_MS)` would floor that to "0 days", which is worse
 * than naming nothing, so a sub-day window is reported in hours instead.
 */
function windowText(ms: number): string {
  const d = days(ms);
  if (d >= 1) return `${d} ${d === 1 ? "day" : "days"}`;
  const h = hours(ms);
  return `${h} ${h === 1 ? "hour" : "hours"}`;
}

/** "3h 15m" from a count of seconds. */
export function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * A payload's ISO-string instant, as a `<t:…:F>` token, or `null` if it is
 * unrepresentable. `at` returns `null` for an unparseable `Date` (a jsonb
 * payload is not validated at write time); the caller — never this
 * function — owns the degrade, matching `war-log-text.ts`'s rule: drop the
 * clause rather than post a literal "NaN undefined NaN" that a permanent DM
 * would carry forever (see `notice-text.test.ts`).
 */
function atToken(v: NoticePayload[string] | undefined): string | null {
  return at(new Date(String(v)));
}

/** Same as `atToken`, but for `atRel`'s `<t:…:F> (<t:…:R>)` pair. */
function atRelToken(v: NoticePayload[string] | undefined): string | null {
  return atRel(new Date(String(v)));
}

/**
 * A payload's gamertag slot, honestly. A missing name renders as `someone`;
 * an all-digit value is a raw Discord id (see `gamertagOrId` in
 * `packages/roster/src/internal/feed-actor.ts`) and renders as a MENTION,
 * not a link — a mention pings, which is the entire reason that fallback
 * exists (`PING_KINDS` in `notice-tick.ts`). Only a real gamertag becomes a
 * profile link.
 */
function person(v: NoticePayload[string] | undefined, site: string): string {
  if (v === null || v === undefined || v === "") return "someone";
  const s = String(v);
  return /^\d+$/u.test(s) ? `<@${s}>` : playerLink(site, s);
}

/**
 * ⚠️ `age` is a Discord `<t:…:R>` token, not a baked string. It used to be
 * `relativeAge(occurredAt, now)`, which froze "6 min ago" into a message
 * that then sat in a channel for weeks saying so. The token counts by
 * itself, which is why `noticeText` no longer takes a clock at all.
 */
type RendererCtx = { target: NoticeTarget; age: string; site: string; dormantAfterMs: number };
type Renderer = (p: NoticePayload, ctx: RendererCtx) => string;

/** The " — <token>" clause, or nothing when `age` degraded to "" (an
 * unrepresentable `occurredAt`) — never a dangling " — ". */
const since = (ctx: RendererCtx) => (ctx.age === "" ? "" : ` — ${ctx.age}`);

/**
 * One arrow function per `ClanNoticeKind`, reading only the named keys its
 * writer actually put in the payload (see the task-7 report for the table).
 * `notice-text.test.ts`'s exhaustiveness check pins this to exactly
 * `CLAN_NOTICE_KINDS` — no more, no less (spec §13).
 *
 * A clan name becomes `clanLink` only where its payload also carries the
 * TAG the writer froze at write time — re-reading `factions` here to find a
 * tag would print a renamed clan's current name on a late post. Where the
 * payload has a name but no tag, it stays bold and unlinked.
 */
export const RENDERERS: Record<ClanNoticeKind, Renderer> = {
  flag_down: (p, ctx) => {
    const of = p.raiderClan ? ` of ${p.raiderClan}` : "";
    return `🚨 Your flag is down — lowered by ${person(p.gamertag, ctx.site)}${of}. Re-raise within ${hours(RAID_DEDUP_MS)}h or go dormant. Crate paused, spare flag still at your pole.`;
  },
  defended: (p, ctx) => `🛡️ ${person(p.gamertag, ctx.site)} raised the flag. Defended — ${duration(Number(p.durationSeconds))} under siege. Supplies resume at next restart.`,
  // ⚠️ RAID_DEDUP_MS, not a typed "24 hours" — see the task-9 report for why
  // this one (unlike dormant_inactive) IS the right domain constant: the
  // dedup window is a fixed rule, never read from bot config.
  dormant_raided: () => `💤 ${hours(RAID_DEDUP_MS)} hours passed. You're dormant. Any member raising the flag brings you back.`,
  // ⚠️ THE TRAP: `@factions/domain`'s DORMANT_AFTER_MS is NOT what the bot
  // runs — `cfg.dormantAfterMs` (BOT_DORMANT_AFTER_MS, config.ts) is, and
  // staging can set it under a day. `ctx.dormantAfterMs` is threaded in from
  // there via `noticeMessage`/`noticeTick`, the same path `siteBaseUrl`
  // takes, so this notice can never name a number this server does not use.
  dormant_inactive: (_p, ctx) => `💤 No member has raised the flag in ${windowText(ctx.dormantAfterMs)}. You're dormant. Crate stopped, spare flag still at your pole.`,
  revived: (p, ctx) => (p.gamertag ? `☀️ ${person(p.gamertag, ctx.site)} raised the flag. You're active again.` : "☀️ The flag was raised. You're active again."),
  disband_warning: (p) => `⚠️ ${p.days} days until this clan is disbanded and the flag returns to the pool.`,
  non_member_raise: (p, ctx) => `⚑ ${person(p.gamertag, ctx.site)} (not a member) raised your flag at your base${since(ctx)}`,
  colors_elsewhere: (p, ctx) => `🏴 Your flag is flying at a pole that isn't yours — raised by ${person(p.gamertag, ctx.site)}`,
  rebind_proposed: (p, ctx) => `📦 ${person(p.gamertag, ctx.site)} raised our flag at a new pole. Leader: confirm the move within ${hours(REBIND_CONFIRM_MS)}h: [open it](<${p.link}>)`,
  rebind_confirmed: () => `📦 Moved. Supplies follow at the next restart. The old base goes public in ${days(RELEASED_POLE_GRACE_MS)} days.`,
  joined: (p, ctx) => `➕ ${person(p.gamertag, ctx.site)} joined — pending until seen at the base`,
  became_full: (p, ctx) => `✅ ${person(p.gamertag, ctx.site)} is now a full member (seen at the base)`,
  left: (p, ctx) => `➖ ${person(p.gamertag, ctx.site)} left`,
  // p.clan carries no tag on this payload (see roster-store.ts), so it stays
  // bold and unlinked rather than guessing at a page.
  kicked: (p, ctx) => {
    if (ctx.target === "channel") return `🥾 ${person(p.gamertag, ctx.site)} was kicked by ${person(p.officer, ctx.site)}`;
    // ⚠️ An unrepresentable `until` drops the whole "you can join again" clause
    // rather than naming a garbage date — the sentence without it states
    // nothing false, unlike ban_applied below (see its comment).
    const until = atToken(p.until);
    return until
      ? `You were removed from **${p.clan}**. You can join a clan again on ${until}.`
      : `You were removed from **${p.clan}**.`;
  },
  promoted: (p, ctx) => `⬆️ ${person(p.gamertag, ctx.site)} promoted to officer`,
  demoted: (p, ctx) => `⬇️ ${person(p.gamertag, ctx.site)} demoted to member`,
  transferred: (p, ctx) => `👑 ${person(p.gamertag, ctx.site)} is now leader (transferred by ${person(p.old, ctx.site)})`,
  renamed: (p, ctx) => `✏️ We are now ${clanLink(ctx.site, String(p.tag), String(p.name))}.`,
  invited: (p, ctx) => `${clanLink(ctx.site, String(p.tag), String(p.clan))} invited you. Accept or decline: [open it](<${p.link}>)`,
  // request_accepted/declined and pending_expired carry a clan NAME only, no
  // tag (requests.ts, presence-tick.ts) — bold and unlinked, same rule.
  request_accepted: (p) => `**${p.clan}** accepted your request. Go stand at the base to become a full member.`,
  request_declined: (p) => `**${p.clan}** declined your request.`,
  pending_expired: (p) => `Your spot in **${p.clan}** expired — you were never seen at the base.`,
  solo_non_member_raise: (p, ctx) => `⚑ ${person(p.gamertag, ctx.site)} (not a member) raised your flag at your base${since(ctx)}`,
  solo_lapsed: (p) => `Your base declaration lapsed — no raise in ${days(SOLO_LAPSE_MS)} days. The pole goes public in ${days(RELEASED_POLE_GRACE_MS)} days unless you raise there and declare again: [open it](<${p.link}>)`,
  intruder: (p, ctx) => `👁 ${person(p.gamertag, ctx.site)} (not a member) was seen ${p.distance} m from your base${since(ctx)}`,
  dismantle: (p, ctx) => `🔧 ${person(p.gamertag, ctx.site)} (not a member) dismantled ${p.part} at your base${since(ctx)}`,
  gate_built: (p, ctx) => `🔧 ${person(p.gamertag, ctx.site)} (not a member) built a gate at your base${since(ctx)}`,
  // ⚠️ A non-gate build inside the zone was ALREADY a breach violation
  // (zone-tick.ts folds any base.built by a non-member into the incident);
  // this is only the alert catching up to that — before this kind existed,
  // a watchtower going up next to your base was recorded silently and
  // surfaced only if you happened to check /base. Names the part so an
  // owner can tell a watchtower from a fence.
  built: (p, ctx) => `🔧 ${person(p.gamertag, ctx.site)} (not a member) built ${p.part} at your base${since(ctx)}`,
  solo_intruder: (p, ctx) => `👁 ${person(p.gamertag, ctx.site)} (not a member) was seen ${p.distance} m from your base${since(ctx)}`,
  solo_dismantle: (p, ctx) => `🔧 ${person(p.gamertag, ctx.site)} (not a member) dismantled ${p.part} at your base${since(ctx)}`,
  solo_gate: (p, ctx) => `🔧 ${person(p.gamertag, ctx.site)} (not a member) built a gate at your base${since(ctx)}`,
  solo_built: (p, ctx) => `🔧 ${person(p.gamertag, ctx.site)} (not a member) built ${p.part} at your base${since(ctx)}`,
  leader_removed: (p, ctx) => `👑 ${person(p.old, ctx.site)} is no longer in the Discord. ${person(p.new, ctx.site)} is now leader.`,
  succession_claimed: (p, ctx) => `⏳ ${person(p.gamertag, ctx.site)} has claimed leadership — ${person(p.leader, ctx.site)} has ${hours(SUCCESSION_WINDOW_MS)}h to show up in game`,
  succession_voided: (p, ctx) => `⏳ ${person(p.leader, ctx.site)} showed up in game. The claim by ${person(p.claimant, ctx.site)} is void.`,
  succession_done: (p, ctx) => `👑 ${person(p.gamertag, ctx.site)} is now leader (succession)`,
  vote_opened: (p, ctx) => {
    // ⚠️ An unrepresentable closesAt drops the "Closes …" clause entirely —
    // the vote is still open and still linked, so the sentence without it
    // states nothing false.
    const closes = atRelToken(p.closesAt);
    const closesClause = closes ? ` Closes ${closes}.` : "";
    return `🗳️ Vote opened: replace ${person(p.leader, ctx.site)} with ${person(p.nominee, ctx.site)}.${closesClause} Vote on the site: [open it](<${p.link}>)`;
  },
  vote_passed: (p, ctx) => `🗳️ Vote passed (${p.yes}/${p.n}). ${person(p.nominee, ctx.site)} is now leader; ${person(p.old, ctx.site)} stays as officer.`,
  vote_failed: (p) => {
    // ⚠️ An unrepresentable date drops the whole "Next vote possible …"
    // sentence — omitting it states nothing false, unlike naming a garbage
    // date that looks like a real (wrong) rule.
    const next = atToken(p.date);
    return next ? `🗳️ Vote failed (${p.yes}/${p.n}). Next vote possible ${next}.` : `🗳️ Vote failed (${p.yes}/${p.n}).`;
  },
  // codes_rotated's DM arm carries a clan NAME only, no tag (vault-store.ts)
  // — bold and unlinked, same rule as kicked/invited above.
  codes_rotated: (p, ctx) =>
    ctx.target === "channel"
      ? `🔐 Codes rotated by ${person(p.gamertag, ctx.site)} — see the vault.`
      : `**${p.clan}** rotated its codes. See the vault: [open it](<${p.link}>)`,
  guest: (p, ctx) => `🎟️ ${person(p.officer, ctx.site)} gave ${person(p.user, ctx.site)} a ${hours(GUEST_PASS_MS)}h voice guest pass.`,
  achievement: (p, ctx) => {
    // The clan-owner case DOES carry `clanTag` (achievements/tick.ts) — link
    // it; the player-owner case already goes through `person`, which is the
    // one arm that must stay a mention for an all-digit id.
    const owner = p.ownerKind === "clan"
      ? (p.clanTag ? clanLink(ctx.site, String(p.clanTag), String(p.ownerName)) : `**${p.ownerName}**`)
      : person(String(p.ownerName), ctx.site);
    return `🏆 ${owner}${p.clanTag && p.ownerKind === "player" && p.public ? ` [${p.clanTag}]` : ""} earned **${p.name}** — ${p.description}.`;
  },
  zone_warning: (p, ctx) => {
    const acts = [
      Number(p.dismantled) > 0 ? `dismantling ${p.dismantled} part(s)` : null,
      Number(p.built) > 0 ? `building ${p.built} part(s)` : null,
      Number(p.stacked) > 0 ? `stacking ${p.stacked} item(s)` : null,
    ].filter(Boolean).join(" and ");
    return `⚠️ The log recorded you ${acts} inside ${clanLink(ctx.site, String(p.tag))}'s declared base zone. **If they asked you to help, ignore this.** If not, an officer of that clan can report it, and the penalty scales with the damage.`;
  },
  ban_applied: (p) => {
    if (!p.until) return `⛔ You are permanently banned from the server — ${p.reason}.`;
    // ⚠️ Unlike the other three sites, simply dropping the clause here would
    // read as "You are banned from the server — reason." — indistinguishable
    // from the permanent-ban sentence above, which is a lie for a temporary
    // ban. Naming the term without a garbage date keeps this arm honest.
    const until = atToken(p.until);
    return until
      ? `⛔ You are banned from the server until ${until} — ${p.reason}.`
      : `⛔ You are banned from the server for a limited time — ${p.reason}.`;
  },
  booster_kit_unchosen: () =>
    "Thanks for boosting. You have a kit waiting: nine pieces of clothing that respawn "
    + "at a spot you pick, every restart, for as long as you keep boosting. Nothing is "
    + "chosen yet, so nothing will spawn.",
  award_granted: (p) => {
    // ⚠️ The deadline clause is DROPPED on an unparseable date rather than
    // printed: a DM is permanent, and "by <t:NaN:F>" would sit in it forever.
    const by = atToken(p.placeBy);
    const reason = typeof p.reason === "string" && p.reason ? ` (${p.reason})` : "";
    return `🏆 You won **${p.label ? String(p.label) : "an award"}**${reason}. `
      + `Choose your gear and mark where it spawns${by ? ` by ${by}` : ""}. `
      + "It respawns there every restart until the award runs out.";
  },
};

export function noticeText(
  n: { kind: ClanNoticeKind; target: NoticeTarget; occurredAt: Date; payload: NoticePayload },
  siteBaseUrl: string,
  // ⚠️ Required, no default. A default here would be exactly the trap this
  // task removed: dormancy.ts's own DEFAULT_DORMANT_AFTER_MS IS the domain
  // constant, so a caller that forgot to pass this would silently render
  // "7 days" on a staging box where BOT_DORMANT_AFTER_MS is under a day —
  // the compiler must refuse that caller instead. See noticeMessage/noticeTick.
  dormantAfterMs: number,
): string {
  // ⚠️ `?? ""` is the degrade for an unrepresentable occurredAt: the line
  // loses its "when" rather than posting a literal <t:NaN:R> that nothing
  // will ever repost over.
  return RENDERERS[n.kind](n.payload, { target: n.target, age: rel(n.occurredAt) ?? "", site: siteBaseUrl, dormantAfterMs });
}

/** A Discord action row carrying link buttons. Concrete on purpose: `unknown[]`
 *  does not satisfy discord.js's MessageCreateOptions, and a test that reads
 *  `msg.components[0].components` cannot dereference it. */
export type NoticeActionRow = {
  type: 1;
  components: { type: 2; style: 5; label: string; url: string }[];
};

/**
 * The components a notice carries, or undefined for the many that carry none.
 *
 * ⚠️ A URL button (style 5) on purpose: it needs no interaction handler, so it
 * adds no state to the bot and nothing has to route it. A style 2 button would
 * need a custom_id and a handler for a message whose only job is a link.
 */
export function noticeComponents(n: { kind: ClanNoticeKind; payload: NoticePayload }): NoticeActionRow[] | undefined {
  const button = LINK_BUTTONS[n.kind];
  if (!button) return undefined;
  const url = n.payload[button.field];
  if (typeof url !== "string" || !url) return undefined;
  return [{ type: 1, components: [{ type: 2, style: 5, label: button.label, url }] }];
}

/** The kinds whose DM carries one link button, and the payload field that holds its URL. */
const LINK_BUTTONS: Partial<Record<ClanNoticeKind, { label: string; field: string }>> = {
  booster_kit_unchosen: { label: "Choose your kit", field: "kitUrl" },
  award_granted: { label: "Configure your award", field: "awardUrl" },
};
