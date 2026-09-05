import type { Database } from "@factions/db";
import { ceremonies, ceremonyParticipants, claimDrafts, factions, factionMembers } from "@factions/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { HOLDING_STATUSES } from "@factions/domain";
import { appendFactionEventTx } from "./feed-store.js";
import { actorGamertagTx } from "./feed-actor.js";
import { declareTx } from "./declaration-store.js";

// Widened to a mutable array: HOLDING_STATUSES is `as const` (a readonly
// tuple) so every faction/domain consumer gets full literal-type checking,
// but drizzle's inArray() requires a plain mutable array.
const HOLDING: string[] = [...HOLDING_STATUSES];

export type OpenCeremony = {
  id: number; serverId: number; poleKey: string; x: string; y: string; z: string;
  participants: { dayzId: string; discordId: string; gamertag: string }[];
};

export interface FactionStore {
  openCeremonyFor(discordId: string): Promise<OpenCeremony | null>;
  openCeremonyByIdFor(ceremonyId: number, discordId: string): Promise<OpenCeremony | null>;
  textureHeld(serverId: number, texture: string): Promise<boolean>;
  saveDraft(ceremonyId: number, discordId: string, d: { name: string; tag: string; texture: string }, at: Date): Promise<void>;
  loadDraft(ceremonyId: number, discordId: string): Promise<{ name: string; tag: string; texture: string } | null>;
  reserve(a: ReserveArgs): Promise<"ok" | "ceremony-taken" | "flag-taken" | "tag-taken" | "pole-taken" | "too-close">;
}

export type ReserveArgs = {
  ceremonyId: number; serverId: number; poleKey: string; x: string; y: string; z: string;
  name: string; tag: string; texture: string;
  leaderDiscordId: string;
  members: { dayzId: string; discordId: string }[];
  at: Date; reservedUntil: Date;
};

/** Unwinds the transaction carrying a non-error outcome, the way roster-store's RosterAbort does. */
class ReserveAbort extends Error {
  constructor(readonly outcome: "too-close" | "pole-taken") { super(outcome); }
}

export class PgFactionStore implements FactionStore {
  constructor(private readonly db: Database) {}

  /**
   * The ceremony a `/faction claim` opens against.
   *
   * ⚠️ ORDER BY + LIMIT 1 is not decoration. A Discord account can be a
   * participant in two provisional ceremonies at once — a group testing two
   * poles — and an unordered query is free to return either row on either
   * call. That stranded the claimant permanently: the draft went against
   * ceremony A, the confirm re-derived ceremony B, and the id mismatch told
   * them "already claimed or expired" on every single retry.
   */
  async openCeremonyFor(discordId: string): Promise<OpenCeremony | null> {
    const [row] = await this.db.select({ c: ceremonies })
      .from(ceremonies)
      .innerJoin(ceremonyParticipants, eq(ceremonyParticipants.ceremonyId, ceremonies.id))
      .where(and(eq(ceremonyParticipants.discordId, discordId), eq(ceremonies.status, "provisional")))
      .orderBy(asc(ceremonies.id))
      .limit(1);
    return row ? this.hydrate(row.c) : null;
  }

  /**
   * The ceremony a confirm NAMES, with the caller checked against its roster.
   *
   * The confirm carries the ceremony id in its custom id, so it must be
   * answered by looking that ceremony up — not by re-deriving one from the
   * user, which is what could hand back a different ceremony than the draft
   * was written against. The participant check is the same §5 defense
   * openCeremonyFor provides, applied to the named row.
   */
  async openCeremonyByIdFor(ceremonyId: number, discordId: string): Promise<OpenCeremony | null> {
    const [row] = await this.db.select({ c: ceremonies })
      .from(ceremonies)
      .innerJoin(ceremonyParticipants, eq(ceremonyParticipants.ceremonyId, ceremonies.id))
      .where(and(
        eq(ceremonies.id, ceremonyId),
        eq(ceremonies.status, "provisional"),
        eq(ceremonyParticipants.discordId, discordId),
      ))
      .limit(1);
    return row ? this.hydrate(row.c) : null;
  }

  private async hydrate(c: typeof ceremonies.$inferSelect): Promise<OpenCeremony> {
    const participants = await this.db.select({
      dayzId: ceremonyParticipants.dayzId,
      discordId: ceremonyParticipants.discordId,
      gamertag: ceremonyParticipants.gamertag,
    }).from(ceremonyParticipants)
      .where(eq(ceremonyParticipants.ceremonyId, c.id))
      .orderBy(asc(ceremonyParticipants.id));
    return {
      id: c.id, serverId: c.serverId, poleKey: c.poleKey,
      x: c.x, y: c.y, z: c.z,
      participants,
    };
  }

  async textureHeld(serverId: number, texture: string): Promise<boolean> {
    const [row] = await this.db.select({ id: factions.id }).from(factions)
      .where(and(
        eq(factions.serverId, serverId),
        eq(factions.texture, texture),
        inArray(factions.status, HOLDING),
      ));
    return row !== undefined;
  }

  async saveDraft(ceremonyId: number, discordId: string, d: { name: string; tag: string; texture: string }, at: Date): Promise<void> {
    await this.db.insert(claimDrafts)
      .values({ ceremonyId, discordId, name: d.name, tag: d.tag, texture: d.texture, createdAt: at })
      .onConflictDoUpdate({
        target: [claimDrafts.ceremonyId, claimDrafts.discordId],
        set: { name: d.name, tag: d.tag, texture: d.texture, createdAt: at },
      });
  }

  async loadDraft(ceremonyId: number, discordId: string) {
    const [row] = await this.db.select().from(claimDrafts)
      .where(and(eq(claimDrafts.ceremonyId, ceremonyId), eq(claimDrafts.discordId, discordId)));
    return row ? { name: row.name, tag: row.tag, texture: row.texture } : null;
  }

  /**
   * Reserve the faction, write the roster, and retire the ceremony — one
   * transaction.
   *
   * ⚠️ Every guard is part of its own write. The ceremony is retired with
   * `status = 'provisional'` in the WHERE clause and its `.returning()` decides
   * whether we won; a pre-read followed by an unconditional write is exactly
   * the defect Plan 2 had to fix twice. The unique-violation catch is the same
   * story for flag and tag: another transaction may commit between any read
   * and this insert, so the index is the only thing that can decide. The pole
   * itself is no longer bound here at all — `declareTx` writes the
   * `declarations` row right after the `factions` insert (lock order: spec
   * §4.12, `factions` then `declarations`), and its own outcome (`too-close`
   * or `pole-taken`) is threaded back out through `ReserveAbort` so this
   * transaction unwinds exactly the way a caught unique-violation does.
   */
  async reserve(a: ReserveArgs): Promise<"ok" | "ceremony-taken" | "flag-taken" | "tag-taken" | "pole-taken" | "too-close"> {
    try {
      return await this.db.transaction(async (tx) => {
        const claimed = await tx.update(ceremonies)
          .set({ status: "claimed" })
          .where(and(eq(ceremonies.id, a.ceremonyId), eq(ceremonies.status, "provisional")))
          .returning({ id: ceremonies.id });
        if (claimed.length === 0) return "ceremony-taken" as const;

        const [f] = await tx.insert(factions).values({
          serverId: a.serverId, name: a.name, tag: a.tag, texture: a.texture,
          status: "reserved", leaderDiscordId: a.leaderDiscordId,
          ceremonyId: a.ceremonyId, createdAt: a.at, reservedUntil: a.reservedUntil,
        }).returning({ id: factions.id });

        // The reservation holds the pole for its 24 h (guide ch. 3), so the
        // declaration is written here, not at activation — and the 200 m
        // refusal happens where the guide says it does: at the claim.
        const declared = await declareTx(tx, {
          serverId: a.serverId, poleKey: a.poleKey, x: Number(a.x), y: Number(a.y), z: Number(a.z),
          owner: { factionId: f!.id }, evidence: { ceremonyId: a.ceremonyId }, at: a.at,
        });
        if (!declared.ok) throw new ReserveAbort(declared.reason === "too-close" ? "too-close" : "pole-taken");

        await tx.insert(factionMembers).values(a.members.map((m) => ({
          factionId: f!.id, serverId: a.serverId, dayzId: m.dayzId, discordId: m.discordId,
          role: m.discordId === a.leaderDiscordId ? "leader" : "member",
          joinedAt: a.at,
        })));

        // ⚠️ Inside this transaction, and last of the roster writes. Lock
        // order: factions → faction_members → faction_invites →
        // faction_events. A separate write would leave a founding that is
        // never announced if this process died between the two.
        await appendFactionEventTx(tx, {
          serverId: a.serverId, factionId: f!.id, kind: "founded", occurredAt: a.at,
          payload: {
            name: a.name, tag: a.tag, texture: a.texture,
            actor: await actorGamertagTx(tx, a.leaderDiscordId),
          },
        });

        await tx.delete(claimDrafts).where(eq(claimDrafts.ceremonyId, a.ceremonyId));
        return "ok" as const;
      });
    } catch (err) {
      if (err instanceof ReserveAbort) return err.outcome;
      const msg = String(err);
      if (msg.includes("factions_holding_texture_uniq")) return "flag-taken";
      if (msg.includes("factions_holding_tag_uniq")) return "tag-taken";
      throw err;
    }
  }
}
