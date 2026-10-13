import type { Database } from "@factions/db";
import { declarations, defenses, factionMembers, factions, identityLinks, seasonStandings } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { appendWarLogTx, appendFactionEventTx, announceFlagChangeTx, completeFlagChangeTx, noticeClanTx, noticeUserTx } from "@factions/roster/internal";
import { adoptCarriedTx, declarationForFaction, declareTx } from "@factions/declarations";
import { CARRIED_ADOPT_RADIUS_M, FLAG_DOWN_MS, NEUTRAL_FLAG, distance2d } from "@factions/domain";
import { and, eq, sql } from "drizzle-orm";
import { openSeason } from "./season.js";
import { reviveFactionTx } from "./dormancy-store.js";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const RAISE_CONSUMER = "raise-consumer";

export type RaiseTickResult = { scanned: number; defenses: number; revived: number; noticed: number; bound: number; adopted: number };

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type BindingClan = { id: number; name: string; tag: string; texture: string; status: string };

type FlagPayload = { dayzId: string; gamertag: string; texture: string; poleKey: string; pole: { x: number; y: number; z: number } };
function readFlagPayload(payload: unknown): FlagPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || typeof p.gamertag !== "string" || typeof p.texture !== "string" || typeof p.poleKey !== "string") return null;
  const pole = p.pole as Record<string, unknown> | undefined;
  if (typeof pole !== "object" || pole === null || typeof pole.x !== "number" || typeof pole.y !== "number" || typeof pole.z !== "number") return null;
  return { dayzId: p.dayzId, gamertag: p.gamertag, texture: p.texture, poleKey: p.poleKey, pole: { x: pole.x, y: pole.y, z: pole.z } };
}

/**
 * Every `flag.raised` the roster cares about, in one pass (spec §7: defense,
 * revive, non-member raise, colors elsewhere, rebind proposal). Activation
 * stays in ceremony-tick; the 7-day clock stays in dormancy-tick. Order of
 * checks per event:
 *   1. the pole is a clan's declaration → member/non-member branch
 *   2. else the pole is a solo declaration → non-member DM
 *   3. else the raiser's clan has a carried base within CARRIED_ADOPT_RADIUS_M → adopt
 *   4. else White → bind a baseless clan; the clan's texture → proposal or colors elsewhere
 *
 * ⚠️ Lock order (§4.12): `factions` FOR UPDATE first, then declarations,
 * poles, faction_members, … `season_standings` BEFORE `defenses`, then
 * faction_events, war_log_events, clan_notices last. The spec fixes
 * `season_standings → raids → defenses` as an order that is "extended, never
 * reordered" — `raid-tick.ts` writes standings before its `raids` row for the
 * same reason, and the defense branch below writes standings before
 * `defenses` to match.
 */
export async function raiseTick(db: Database, opts: { batchSize?: number; siteBaseUrl: string }): Promise<RaiseTickResult> {
  const batchSize = opts.batchSize ?? 500;
  const out: RaiseTickResult = { scanned: 0, defenses: 0, revived: 0, noticed: 0, bound: 0, adopted: 0 };
  let cursor = await readCursor(db, RAISE_CONSUMER);
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.raised") continue;
      const p = readFlagPayload(ev.payload);
      if (!p) continue;
      out.scanned++;
      const r = await db.transaction(async (tx) => {
        // ⚠️ Every exit from this transaction goes through `done`, which
        // commits the consumer cursor in the SAME transaction as the event's
        // effects. Four of the branches below (non_member_raise,
        // solo_non_member_raise, rebind_proposed, colors_elsewhere) write
        // nothing but a queue row and so have no unique key to dedupe on; the
        // cursor is what makes them replay-proof. A mid-batch failure now
        // rolls back exactly the unfinished event.
        //
        // ⚠️ `last` holds queue writes that must land LAST in this transaction
        // (§4.12: faction_events and clan_notices after every roster table),
        // after whichever branch below finishes — today the flag_changed
        // announcement, which the defense or revive the same raise performs
        // must precede. Declared per event so each one starts empty; `done`
        // drains it before the cursor write so a replay can never re-announce.
        // ⚠️ Ordering exception, deliberate: in the defense branch the
        // deferred `faction_events` row lands AFTER that branch's
        // `war_log_events` row and notice, not before as §4.12 lists them.
        // All three are insert-only queues here: a fresh insert waits on no
        // other row, and the posters only mark rows already committed, one
        // table per statement — so no lock cycle can form. The only effect is
        // that the flag_changed feed row gets the later id.
        const last: (() => Promise<void>)[] = [];
        const done = async <T,>(v: T): Promise<T> => {
          for (const f of last) await f();
          await writeCursor(tx, RAISE_CONSUMER, ev.id);
          return v;
        };
        const [decl] = await tx.select({ ownerFactionId: declarations.ownerFactionId, ownerDayzId: declarations.ownerDayzId })
          .from(declarations).where(and(eq(declarations.serverId, ev.serverId), eq(declarations.poleKey, p.poleKey)));

        if (decl?.ownerFactionId) {
          const [clan] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, status: factions.status, flagDownSince: factions.flagDownSince })
            .from(factions).where(eq(factions.id, decl.ownerFactionId)).for("update");
          if (!clan) return done(null);
          const [full] = await tx.select({ id: factionMembers.id }).from(factionMembers)
            .where(and(eq(factionMembers.factionId, clan.id), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
          if (!full) {
            if (clan.status === "active" || clan.status === "dormant") {
              await noticeClanTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "non_member_raise", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
              return done("noticed" as const);
            }
            return done(null);
          }
          if (p.texture !== clan.texture) {
            // Spec 2026-10-13 §3: the clan's PENDING flag, raised at home by
            // a full member before the deadline, becomes its flag — and this
            // same raise then defends, revives or upkeeps below like any
            // raise of the clan's own colors. Anything else foreign is nothing.
            // ⚠️ `clan.texture` is the OLD flag from here on; nothing below
            // reads it, and the announcement carries the new one explicitly.
            const changed = clan.status === "active" || clan.status === "dormant"
              ? await completeFlagChangeTx(tx, { factionId: clan.id, serverId: ev.serverId, texture: p.texture, at: ev.occurredAt })
              : null;
            // Null also when another holding clan already flies this texture
            // (completeFlagChangeTx logs it): never a throw, which would roll
            // back the cursor and retry this event every tick.
            if (!changed) return done(null); // a member raising a foreign flag at home is nothing
            last.push(() => announceFlagChangeTx(tx, {
              serverId: ev.serverId, factionId: clan.id, name: changed.name, tag: changed.tag,
              texture: p.texture, previousTexture: changed.previousTexture, gamertag: p.gamertag, at: ev.occurredAt,
            }));
          }
          // ⚠️ Bounded by FLAG_DOWN_MS (§5.8). `dormancy-tick` decides against
          // wall-clock now while this consumer decides against event time, and
          // during any backlog (bot down, ingest catching up) a raise can
          // arrive long after the flag went down. A raise at or after
          // `flag_down_since + FLAG_DOWN_MS` is NOT a defense: it scores
          // nothing and, crucially, does not clear `flag_down_since`, so the
          // dormancy clock still converts the clan to dormant(raided) and this
          // same raise revives it through the dormant branch below on a later
          // tick — the state machine §5.8 describes.
          const siegeMs = clan.flagDownSince === null ? 0 : ev.occurredAt.getTime() - clan.flagDownSince.getTime();
          if (clan.status === "active" && clan.flagDownSince !== null && siegeMs < FLAG_DOWN_MS) {
            const season = await openSeason(tx, ev.serverId);
            if (!season) return done(null);
            const siege = Math.max(0, Math.floor(siegeMs / 1000));
            // ⚠️ Replay guard, and the reason the standings increment below is
            // safe. A plain SELECT takes no lock, so §4.12 is unaffected, and
            // the clan's `factions` row is already held FOR UPDATE — no other
            // transaction can insert a defense for this clan meanwhile. If the
            // defense row for this event already exists, the whole branch has
            // already been applied: do not double-count the standings, the
            // war-log line or the notice.
            const [already] = await tx.select({ id: defenses.id }).from(defenses).where(eq(defenses.eventId, ev.id));
            if (already) return done(null);
            // Standings before defenses, per §4.12's documented lock order
            // ("extended, never reordered") — the same order raid-tick.ts
            // writes standings before its raids row.
            await tx.insert(seasonStandings).values({ seasonId: season.id, factionId: clan.id, defenses: 1 })
              .onConflictDoUpdate({ target: [seasonStandings.seasonId, seasonStandings.factionId], set: { defenses: sql`${seasonStandings.defenses} + 1` } });
            await tx.insert(defenses).values({ factionId: clan.id, seasonId: season.id, raisedByDayzId: p.dayzId, eventId: ev.id, flagDownSince: clan.flagDownSince, defendedAt: ev.occurredAt, siegeSeconds: siege })
              .onConflictDoNothing({ target: defenses.eventId });
            await tx.update(factions).set({ flagDownSince: null, flagDownByDayzId: null }).where(eq(factions.id, clan.id));
            await appendWarLogTx(tx, { serverId: ev.serverId, kind: "defense", occurredAt: ev.occurredAt, payload: { victimClan: clan.name, victimTag: clan.tag, gamertag: p.gamertag, durationSeconds: siege } });
            await noticeClanTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "defended", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag, durationSeconds: siege } });
            return done("defense" as const);
          }
          if (clan.status === "dormant") {
            // Shared with the dormancy clock's own revive() (Major #3, review
            // round 1) — see dormancy-store.ts's reviveFactionTx for what it
            // clears and why. The SELECT … FOR UPDATE above already
            // established `status === "dormant"` inside this transaction, so
            // no further guard is needed here. reviveFactionTx itself queues
            // the "revived" notice (with the gamertag, since an actor is
            // given here) — a second one here would double-notify.
            await reviveFactionTx(tx, clan.id, ev.occurredAt, { dayzId: p.dayzId, gamertag: p.gamertag });
            return done("revived" as const);
          }
          return done(null); // an ordinary upkeep raise: the dormancy clock reads it through LAST_RAISE
        }

        if (decl?.ownerDayzId) {
          if (decl.ownerDayzId === p.dayzId) return done(null);
          const [link] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.dayzId, decl.ownerDayzId));
          if (!link) return done(null);
          await noticeUserTx(tx, { serverId: ev.serverId, factionId: null, discordId: link.discordId, kind: "solo_non_member_raise", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
          return done("noticed" as const);
        }

        // Undeclared pole near the raiser's own carried base (the wipe kept
        // the spot, not the pole): the clan's first White or own-flag raise
        // within CARRIED_ADOPT_RADIUS_M is its new base, no confirmation.
        // ⚠️ Keyed off the RAISER's clan, never "any carried base nearby": a
        // White raise beside a neighbour's kit must not move the neighbour.
        // ⚠️ FOR UPDATE per §4.12, factions before adoptCarriedTx's
        // declarations lock. Falls through on anything else, so a raise
        // further out is still an ordinary bind, proposal or nothing.
        const [mine] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, status: factions.status }).from(factions)
          .innerJoin(factionMembers, eq(factionMembers.factionId, factions.id))
          .where(and(
            eq(factions.serverId, ev.serverId), sql`${factions.status} in ('active','dormant')`,
            eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full"),
          ))
          .for("update", { of: factions });
        if (mine && (p.texture === NEUTRAL_FLAG || p.texture === mine.texture)) {
          const carried = await declarationForFaction(tx, mine.id);
          // ⚠️ A raise dated before the wipe is the OLD world's pole, which no
          // longer exists: the bot can stop before the game wipes and process
          // that gap after restart. Adopting it would clear carried_since and
          // leave the base on a dead pole, silently. Such a raise falls through.
          if (carried?.carriedSince && ev.occurredAt >= carried.carriedSince && distance2d({ x: p.pole.x, z: p.pole.z }, { x: Number(carried.x), z: Number(carried.z) }) <= CARRIED_ADOPT_RADIUS_M) {
            const adopted = await adoptCarriedTx(tx, {
              serverId: ev.serverId, factionId: mine.id, poleKey: p.poleKey, x: p.pole.x, y: p.pole.y, z: p.pole.z, eventId: ev.id, at: ev.occurredAt,
            });
            if (!adopted.ok) {
              console.info(`raise-tick: adopt refused for faction ${mine.id} at ${p.poleKey}: ${adopted.reason}`);
              return done(null);
            }
            await afterRebindTx(tx, ev, p, mine);
            return done("adopted" as const);
          }
        }

        // Undeclared pole, White flag: a full member re-establishing a clan
        // that has no base, the post-wipe case. Clan flags never spawn as
        // loot and the supply kit (the only source of one) needs a bound
        // base, so after a wipe a clan's own flag cannot be had; White can.
        // The bind brings the kit back, and the kit brings the clan's flag.
        // ⚠️ Only a clan with NO declaration. White at a free pole is also
        // founding-ceremony material (ceremony-tick), and a clan that still
        // has a base moves it through the rebind proposal, never this way.
        // The bind marks the pole bound, which ceremony-tick re-checks before
        // it settles any window, so the two cannot both take the pole.
        if (p.texture === NEUTRAL_FLAG) {
          // ⚠️ FOR UPDATE per §4.12, as in the clan-flag path below.
          const [clan] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, status: factions.status }).from(factions)
            .innerJoin(factionMembers, eq(factionMembers.factionId, factions.id))
            .where(and(
              eq(factions.serverId, ev.serverId), sql`${factions.status} in ('active','dormant')`,
              eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full"),
            ))
            .for("update", { of: factions });
          if (!clan || await declarationForFaction(tx, clan.id)) return done(null);
          return done(await bindTx(tx, ev, p, clan));
        }

        // Undeclared pole: does the texture belong to a holding clan on this server?
        // ⚠️ FOR UPDATE per §4.12 (`factions` before `declarations`): this
        // branch may go on to call `declareTx`, which takes the declarations
        // advisory lock, so the clan's `factions` row must be locked first.
        const [owner] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, status: factions.status }).from(factions)
          .where(and(eq(factions.serverId, ev.serverId), eq(factions.texture, p.texture), sql`${factions.status} in ('reserved','active','dormant')`))
          .for("update");
        if (!owner || owner.status === "reserved") return done(null); // activation is ceremony-tick's
        const [full] = await tx.select({ id: factionMembers.id }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, owner.id), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
        if (!full) {
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: owner.id, kind: "colors_elsewhere", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
          return done("noticed" as const);
        }

        // §8.5: a holding clan with NO declaration binds one on the first
        // `flag.raised` of its texture by a full member, at any free pole —
        // the post-wipe case. A clan that still has a declaration keeps
        // today's rebind-proposal path unchanged.
        const existing = await declarationForFaction(tx, owner.id);
        if (existing) {
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: owner.id, kind: "rebind_proposed", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag, link: `${opts.siteBaseUrl}/clan/settings` } });
          return done("noticed" as const);
        }

        return done(await bindTx(tx, ev, p, owner));
      });
      if (r === "defense") out.defenses++;
      else if (r === "revived") out.revived++;
      else if (r === "noticed") out.noticed++;
      else if (r === "bound") out.bound++;
      else if (r === "adopted") out.adopted++;
    }
    // The tail: events this consumer skipped outright (wrong type, unparseable
    // payload) opened no transaction. They have no effects, so replaying them
    // is free — this write just saves the next tick from re-reading them.
    await writeCursor(db, RAISE_CONSUMER, cursor);
  }
  return out;
}

/**
 * §8.5: bind a holding clan with no declaration to the raised pole, reviving
 * it if dormant. The caller holds the clan's `factions` row FOR UPDATE.
 */
async function bindTx(tx: Tx, ev: { id: number; serverId: number; occurredAt: Date }, p: FlagPayload, clan: BindingClan): Promise<"bound" | null> {
  const declared = await declareTx(tx, {
    serverId: ev.serverId, poleKey: p.poleKey, x: p.pole.x, y: p.pole.y, z: p.pole.z,
    owner: { factionId: clan.id }, evidence: { eventId: ev.id }, at: ev.occurredAt,
  });
  if (!declared.ok) {
    // ⚠️ No notice kind exists for this (ruling: §9.3 lists none) and
    // nothing else is written — the site's clan page will show "no
    // base" once increment 5 lands. Logged so an operator can still
    // see it happened.
    console.info(`raise-tick: bind refused for faction ${clan.id} at ${p.poleKey}: ${declared.reason}`);
    return null;
  }
  await afterRebindTx(tx, ev, p, clan);
  return "bound";
}

/** The `rebound` feed row and, for a dormant clan, the revive — shared by a bind and an adoption. */
async function afterRebindTx(tx: Tx, ev: { serverId: number; occurredAt: Date }, p: FlagPayload, clan: BindingClan): Promise<void> {
  await appendFactionEventTx(tx, {
    serverId: ev.serverId, factionId: clan.id, kind: "rebound", occurredAt: ev.occurredAt,
    payload: { name: clan.name, tag: clan.tag, texture: clan.texture },
  });
  if (clan.status === "dormant") {
    await reviveFactionTx(tx, clan.id, ev.occurredAt, { dayzId: p.dayzId, gamertag: p.gamertag });
  }
}
