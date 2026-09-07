import type { Database } from "@factions/db";
import { factionMembers, factions, guestPasses, identityLinks, rosterCooldowns, servers } from "@factions/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { HOLDING_STATUSES, ROSTER_COOLDOWN_MS } from "@factions/domain";
import { lockDeclarations, releaseTx } from "@factions/declarations";
import { applyElectorateLeaveTx, closeLeadershipSilentlyTx, lockFactionTx } from "./leadership-store";
import { disbandFactionTx } from "./roster-store";
import { exposeLocksTx } from "./vault-store";
import { gamertagOrId } from "./feed-actor";
import { noticeClanTx } from "./notices";

/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Widened for drizzle's inArray(), the same way roster-store.ts does it. A
// disbanded clan holds nobody: a roster row on one is not a membership.
const HOLDING: string[] = [...HOLDING_STATUSES];

export type RemovalRoster = "none" | "member-left" | "leader-succeeded" | "leader-disbanded";

export type RemovalResult = {
  /** False when the id had no `identity_links` row — nothing was written. */
  linked: boolean;
  roster: RemovalRoster;
  /** The new leader's Discord id on `leader-succeeded`; null otherwise. */
  successorDiscordId: string | null;
  /** Whether the user's OWN solo declaration was released (never the clan's). */
  releasedSoloBase: boolean;
};

const NOTHING: RemovalResult = { linked: false, roster: "none", successorDiscordId: null, releasedSoloBase: false };

/**
 * `guildMemberRemove` — the one roster write that starts at a Discord
 * gateway event rather than the log, a clock or the site (spec §5.4), which
 * is why it lives here and not behind a package-root export the web could
 * reach.
 *
 * The guide: "being removed from the Discord removes you from everything."
 * So, in ONE transaction: the roster row goes, the identity link goes, the
 * solo base is released, and any guest pass the user holds anywhere is
 * revoked. The roster half depends on who they were (spec §5.4):
 *
 * - **the leader**, with anyone left → the seat passes to the
 *   longest-tenured officer by `joined_at`, else the longest-tenured full
 *   member, and NO cooldown is stamped on anybody. There is no vote and no
 *   claim to settle afterwards: whatever leadership business was open was
 *   ABOUT this person, so `closeLeadershipSilentlyTx` closes it with no
 *   cooldown and no notice (ruling 11). The vault IS exposed: they knew
 *   every code, leader-only locks included.
 * - **the leader, alone** → `disbandFactionTx`, the same one `/faction
 *   disband` and the dormancy tick ride, with a `true` guard: the check
 *   ("is this the leader, and is anyone left?") has already been made here.
 * - **anyone else** → exactly a `leave`: cooldown, electorate slot, vault
 *   exposure, `left` notice. A PENDING member is removed too, but takes
 *   neither of the last two — they were in no electorate and could see no
 *   lock (§4.5).
 *
 * ⚠️ Lock order (§4.12), and it spans nearly the whole list: the identity
 * link row (`for update`, as `unlinkDb` does, so an `unlink` racing this
 * cannot leave a declaration with no link behind it) → `factions` →
 * declarations → `faction_members` → `faction_votes`/ballots →
 * `succession_claims` → `vault_locks` → `guest_passes` → `faction_events`
 * → `clan_notices`.
 *
 * ⚠️ Idempotent by the link: a second `guildMemberRemove` for the same id
 * finds no link and returns `linked: false` having written nothing. Discord
 * redelivers, and a ban fires `guildMemberRemove` alongside `guildBanAdd`.
 */
export async function removeFromGuildDb(db: Database, a: { discordId: string; at: Date }): Promise<RemovalResult> {
  return db.transaction(async (tx) => {
    const [link] = await tx.select({ id: identityLinks.id, dayzId: identityLinks.dayzId })
      .from(identityLinks).where(eq(identityLinks.discordId, a.discordId)).for("update");
    if (!link) return NOTHING;

    const [member] = await tx.select({
      factionId: factionMembers.factionId, serverId: factionMembers.serverId,
      dayzId: factionMembers.dayzId, role: factionMembers.role, status: factionMembers.status,
    }).from(factionMembers)
      .innerJoin(factions, eq(factions.id, factionMembers.factionId))
      .where(and(eq(factionMembers.discordId, a.discordId), inArray(factions.status, HOLDING)))
      .orderBy(asc(factions.id)).limit(1);

    let roster: RemovalRoster = "none";
    let successorDiscordId: string | null = null;
    let releasedSoloBase = false;

    if (member) {
      // ⚠️ FIRST write-order statement once a clan is involved: `factions`
      // before declarations and before `faction_members`, so a concurrent
      // kick/disband/dormancy tick queues on this row instead of taking the
      // two tables in the opposite order (see `lockFactionTx`).
      await lockFactionTx(tx, member.factionId);
      await lockDeclarations(tx, member.serverId);
      // A PENDING member may still hold a solo base of their own (§5.3), so
      // this runs whatever their status. A full member's declaration is the
      // clan's, and this finds nothing.
      releasedSoloBase = await releaseTx(tx, { dayzId: link.dayzId, serverId: member.serverId }, a.at);

      if (member.role === "leader") {
        await tx.delete(factionMembers)
          .where(and(eq(factionMembers.factionId, member.factionId), eq(factionMembers.discordId, a.discordId)));

        const successor = await successorTx(tx, member.factionId);
        if (successor) {
          // Delete-then-promote, for the same reason `transfer` demotes
          // before it promotes: `faction_members_leader_uniq` permits one
          // leader per faction and the old row is already gone above.
          await tx.update(factionMembers).set({ role: "leader" })
            .where(eq(factionMembers.id, successor.id));
          // Display provenance, kept true by every leader change (§4.5's
          // note on `leader_discord_id`), the way `transfer` does it.
          await tx.update(factions).set({ leaderDiscordId: successor.discordId })
            .where(eq(factions.id, member.factionId));

          // The vote was about this leader's fitness and the claim about
          // their absence; neither question outlives them (ruling 11).
          await closeLeadershipSilentlyTx(tx, member.factionId, a.at);

          // A leader removed from the guild IS a leaver, and the one who
          // knew EVERY code — `leaverRole: "leader"` exposes locks of every
          // `min_role`, the leader-only ones included. Same lock-order slot
          // as the member branch below: after the roster and leadership
          // writes, before `guest_passes` and the notice (§4.12). The
          // disband sub-branch needs no equivalent — the clan's rows go with
          // it on cascade.
          await exposeLocksTx(tx, { factionId: member.factionId, leaverRole: "leader", at: a.at });

          await revokePassesTx(tx, a.discordId, a.at);
          await noticeClanTx(tx, {
            serverId: member.serverId, factionId: member.factionId, kind: "leader_removed", occurredAt: a.at,
            payload: { old: await gamertagOrId(tx, a.discordId), new: await gamertagOrId(tx, successor.discordId) },
          });

          roster = "leader-succeeded";
          successorDiscordId = successor.discordId;
        } else {
          // `sql`true`` on purpose: the guard exists so `/faction disband`
          // can put its leadership check in the UPDATE's own WHERE. Here the
          // leader's row has just been deleted, so no such check could pass
          // — the decision was made above.
          await disbandFactionTx(tx, member.factionId, sql`true`);
          await revokePassesTx(tx, a.discordId, a.at);
          roster = "leader-disbanded";
        }
      } else {
        await tx.delete(factionMembers)
          .where(and(eq(factionMembers.factionId, member.factionId), eq(factionMembers.discordId, a.discordId)));

        // "As a leave, with the cooldown — they cannot rejoin anyway"
        // (§5.4). A floor, never shortened: kick's upsert, verbatim.
        await tx.insert(rosterCooldowns)
          .values({ serverId: member.serverId, dayzId: member.dayzId, until: new Date(a.at.getTime() + ROSTER_COOLDOWN_MS) })
          .onConflictDoUpdate({
            target: [rosterCooldowns.serverId, rosterCooldowns.dayzId],
            set: { until: sql`greatest(${rosterCooldowns.until}, excluded.until)` },
          });

        // §4.5: a pending member voted in nothing and saw no lock, so there
        // is no slot to give back and nothing to expose. Calling either with
        // a pending member would be a no-op today; skipping them says why.
        if (member.status === "full") {
          await applyElectorateLeaveTx(tx, { factionId: member.factionId, dayzId: member.dayzId, at: a.at });
          await exposeLocksTx(tx, {
            factionId: member.factionId, leaverRole: member.role as "leader" | "officer" | "member", at: a.at,
          });
        }

        await revokePassesTx(tx, a.discordId, a.at);
        await noticeClanTx(tx, {
          serverId: member.serverId, factionId: member.factionId, kind: "left", occurredAt: a.at,
          payload: { gamertag: await gamertagOrId(tx, a.discordId) },
        });

        roster = "member-left";
      }
    } else {
      // No holding clan: the solo base can be on any active server, so this
      // sweeps them all, exactly as `unlinkDb` does.
      for (const s of await tx.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).orderBy(asc(servers.id))) {
        await lockDeclarations(tx, s.id);
        if (await releaseTx(tx, { dayzId: link.dayzId, serverId: s.id }, a.at)) releasedSoloBase = true;
      }
      await revokePassesTx(tx, a.discordId, a.at);
    }

    await tx.delete(identityLinks).where(eq(identityLinks.id, link.id));

    return { linked: true, roster, successorDiscordId, releasedSoloBase };
  });
}

/**
 * Who takes the seat: the longest-tenured OFFICER by `joined_at`, else the
 * longest-tenured full member (§5.4). Run AFTER the old leader's row is
 * deleted, so they can never be their own successor. `status = 'full'` on
 * both arms — a pending member is not on the roster (§4.5) and cannot be
 * handed a clan.
 */
async function successorTx(tx: Tx, factionId: number): Promise<{ id: number; discordId: string } | null> {
  const pick = async (role: "officer" | null) => {
    const [row] = await tx.select({ id: factionMembers.id, discordId: factionMembers.discordId })
      .from(factionMembers)
      .where(and(
        eq(factionMembers.factionId, factionId),
        eq(factionMembers.status, "full"),
        ...(role ? [eq(factionMembers.role, role)] : []),
      ))
      .orderBy(asc(factionMembers.joinedAt), asc(factionMembers.id))
      .limit(1);
    return row ?? null;
  };
  return (await pick("officer")) ?? (await pick(null));
}

/**
 * Every open pass this user holds, in ANY clan, goes: the pass was a voice
 * channel in a Discord they are no longer in. `revoked_at`/`converted_at`
 * null is the whole filter — an already-closed pass keeps the timestamp it
 * was closed with, and a pass merely past `expires_at` is already invisible
 * to the reconciler, so re-stamping it would only rewrite history.
 */
async function revokePassesTx(tx: Tx, discordId: string, at: Date): Promise<void> {
  await tx.update(guestPasses).set({ revokedAt: at })
    .where(and(
      eq(guestPasses.discordUserId, discordId),
      isNull(guestPasses.revokedAt),
      isNull(guestPasses.convertedAt),
    ));
}
