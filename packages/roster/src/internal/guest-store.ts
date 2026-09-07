import type { Database } from "@factions/db";
import { guestPasses, factionMembers, factions } from "@factions/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { GUEST_PASS_MS, ROLE_RANK, type ClanRole } from "@factions/domain";
import { lockFactionTx } from "./leadership-store";
import { noticeClanTx } from "./notices";
import { gamertagOrId } from "./feed-actor";

/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

type Role = ClanRole;

/**
 * The caller's role, re-derived inside the transaction from `faction_members`
 * (§4.5: `status = 'full'` is every membership read). `null` covers both
 * "never a member" and "pending" — a pending member has no leadership
 * standing and, per the brief, may still HOLD a guest pass, but never
 * grants or revokes one.
 */
async function currentMemberTx(tx: Tx, factionId: number, discordId: string): Promise<{ role: Role } | null> {
  const [m] = await tx.select({ role: factionMembers.role, status: factionMembers.status })
    .from(factionMembers)
    .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.discordId, discordId)));
  if (!m || m.status !== "full") return null;
  return { role: m.role as Role };
}

export type GrantGuestPassOutcome = "ok" | "not-permitted" | "already-active" | "is-member" | "self";
export type RevokeGuestPassOutcome = "ok" | "not-permitted" | "gone";

export type OpenGuestPass = { id: number; userDiscordId: string; grantedBy: string; expiresAt: Date };

/**
 * Grant a 24 h guest voice pass. Officer+ only. `userDiscordId` must not be
 * a FULL member of this clan (a pending member has no roster standing yet
 * and may still hold a pass — §4.10/ruling 8); no open pass may already
 * exist for that user in this clan.
 *
 * ⚠️ `factions` is locked FIRST (`lockFactionTx`), before either
 * `faction_members` or `guest_passes` is read — "the grant checks for an
 * open pass under the clan's row lock" (§4.10). The self-check needs no
 * lock or read, so it runs before the transaction opens, the same as
 * `kick`'s `cannot-kick-self`.
 */
export async function grantGuestPassDb(
  db: Database,
  a: { factionId: number; actorDiscordId: string; userDiscordId: string; at: Date },
): Promise<{ outcome: GrantGuestPassOutcome; passId: number | null }> {
  if (a.actorDiscordId === a.userDiscordId) return { outcome: "self" as const, passId: null };

  return db.transaction(async (tx) => {
    await lockFactionTx(tx, a.factionId);

    const me = await currentMemberTx(tx, a.factionId, a.actorDiscordId);
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.officer) return { outcome: "not-permitted" as const, passId: null };

    const target = await currentMemberTx(tx, a.factionId, a.userDiscordId);
    if (target) return { outcome: "is-member" as const, passId: null };

    const [open] = await tx.select({ id: guestPasses.id }).from(guestPasses)
      .where(and(
        eq(guestPasses.factionId, a.factionId),
        eq(guestPasses.discordUserId, a.userDiscordId),
        isNull(guestPasses.revokedAt),
        isNull(guestPasses.convertedAt),
        gt(guestPasses.expiresAt, a.at),
      ));
    if (open) return { outcome: "already-active" as const, passId: null };

    const [row] = await tx.insert(guestPasses).values({
      factionId: a.factionId,
      discordUserId: a.userDiscordId,
      grantedByDiscordId: a.actorDiscordId,
      grantedAt: a.at,
      expiresAt: new Date(a.at.getTime() + GUEST_PASS_MS),
    }).returning({ id: guestPasses.id });

    const [f] = await tx.select({ serverId: factions.serverId }).from(factions).where(eq(factions.id, a.factionId));

    await noticeClanTx(tx, {
      serverId: f!.serverId, factionId: a.factionId, kind: "guest", occurredAt: a.at,
      payload: { officer: await gamertagOrId(tx, a.actorDiscordId), user: a.userDiscordId },
    });

    return { outcome: "ok" as const, passId: row!.id };
  });
}

/** Revoke an open pass early. Officer+ only. `gone` covers both "never existed" and "already revoked". */
export async function revokeGuestPassDb(
  db: Database,
  a: { factionId: number; actorDiscordId: string; passId: number; at: Date },
): Promise<RevokeGuestPassOutcome> {
  return db.transaction(async (tx) => {
    await lockFactionTx(tx, a.factionId);

    const me = await currentMemberTx(tx, a.factionId, a.actorDiscordId);
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.officer) return "not-permitted" as const;

    const [row] = await tx.update(guestPasses)
      .set({ revokedAt: a.at })
      .where(and(
        eq(guestPasses.id, a.passId),
        eq(guestPasses.factionId, a.factionId),
        isNull(guestPasses.revokedAt),
      ))
      .returning({ id: guestPasses.id });

    return row ? ("ok" as const) : ("gone" as const);
  });
}

/** Open passes for the settings page: not revoked, not converted, not expired. */
export async function openGuestPassesDb(db: Database, factionId: number, now: Date): Promise<OpenGuestPass[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      id: guestPasses.id,
      userDiscordId: guestPasses.discordUserId,
      grantedByDiscordId: guestPasses.grantedByDiscordId,
      expiresAt: guestPasses.expiresAt,
    }).from(guestPasses)
      .where(and(
        eq(guestPasses.factionId, factionId),
        isNull(guestPasses.revokedAt),
        isNull(guestPasses.convertedAt),
        gt(guestPasses.expiresAt, now),
      ));

    const out: OpenGuestPass[] = [];
    for (const r of rows) {
      out.push({ id: r.id, userDiscordId: r.userDiscordId, grantedBy: await gamertagOrId(tx, r.grantedByDiscordId), expiresAt: r.expiresAt });
    }
    return out;
  });
}

/**
 * For the bot's voice-channel overwrite reconciler: every open pass, keyed
 * by the holding clan's voice channel. A clan with no configured voice
 * channel (`discord_voice_channel_id is null`) is skipped — there is no
 * overwrite to reconcile.
 */
export async function openPassesByVoiceChannel(db: Database, now: Date): Promise<Map<string, Set<string>>> {
  const rows = await db.select({
    channel: factions.discordVoiceChannelId,
    userDiscordId: guestPasses.discordUserId,
  }).from(guestPasses)
    .innerJoin(factions, eq(factions.id, guestPasses.factionId))
    .where(and(
      isNull(guestPasses.revokedAt),
      isNull(guestPasses.convertedAt),
      gt(guestPasses.expiresAt, now),
    ));

  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.channel) continue;
    const set = out.get(r.channel) ?? new Set<string>();
    set.add(r.userDiscordId);
    out.set(r.channel, set);
  }
  return out;
}

/**
 * Reconciler ruling 9: an open pass whose user has since become a FULL
 * member of the granting clan is converted — the role carries the access
 * from here on, so the pass stops being "open" and its overwrite becomes a
 * stray for the reconciler to remove. Returns how many were converted.
 */
export async function convertPassesForFullMembersDb(db: Database, now: Date): Promise<number> {
  const rows = await db.update(guestPasses)
    .set({ convertedAt: now })
    .where(and(
      isNull(guestPasses.revokedAt),
      isNull(guestPasses.convertedAt),
      gt(guestPasses.expiresAt, now),
      sql`exists (
        select 1 from faction_members fm
        where fm.faction_id = ${guestPasses.factionId}
        and fm.discord_id = ${guestPasses.discordUserId}
        and fm.status = 'full'
      )`,
    ))
    .returning({ id: guestPasses.id });
  return rows.length;
}
