import type { Database } from "@factions/db";
import { ceremonies, ceremonyParticipants, claimDrafts, factions, factionMembers } from "@factions/db";
import { and, asc, eq, inArray } from "drizzle-orm";

const HOLDING = ["reserved", "active", "dormant"];

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
  reserve(a: ReserveArgs): Promise<"ok" | "ceremony-taken" | "flag-taken" | "tag-taken" | "pole-taken">;
}

export type ReserveArgs = {
  ceremonyId: number; serverId: number; poleKey: string; x: string; y: string; z: string;
  name: string; tag: string; texture: string;
  leaderDiscordId: string;
  members: { dayzId: string; discordId: string }[];
  at: Date; reservedUntil: Date;
};

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
   * story for flag, tag and pole: another transaction may commit between any
   * read and this insert, so the index is the only thing that can decide. A
   * ceremony can be settled at a pole a faction already holds (e.g. a lapsed
   * reservation's pole re-used before this claim lands), so
   * `factions_holding_pole_uniq` is caught alongside texture and tag.
   */
  async reserve(a: ReserveArgs): Promise<"ok" | "ceremony-taken" | "flag-taken" | "tag-taken" | "pole-taken"> {
    try {
      return await this.db.transaction(async (tx) => {
        const claimed = await tx.update(ceremonies)
          .set({ status: "claimed" })
          .where(and(eq(ceremonies.id, a.ceremonyId), eq(ceremonies.status, "provisional")))
          .returning({ id: ceremonies.id });
        if (claimed.length === 0) return "ceremony-taken" as const;

        const [f] = await tx.insert(factions).values({
          serverId: a.serverId, name: a.name, tag: a.tag, texture: a.texture,
          poleKey: a.poleKey, x: a.x, y: a.y, z: a.z,
          status: "reserved", leaderDiscordId: a.leaderDiscordId,
          ceremonyId: a.ceremonyId, createdAt: a.at, reservedUntil: a.reservedUntil,
        }).returning({ id: factions.id });

        await tx.insert(factionMembers).values(a.members.map((m) => ({
          factionId: f!.id, serverId: a.serverId, dayzId: m.dayzId, discordId: m.discordId,
          role: m.discordId === a.leaderDiscordId ? "leader" : "member",
          joinedAt: a.at,
        })));

        await tx.delete(claimDrafts).where(eq(claimDrafts.ceremonyId, a.ceremonyId));
        return "ok" as const;
      });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("factions_holding_texture_uniq")) return "flag-taken";
      if (msg.includes("factions_holding_tag_uniq")) return "tag-taken";
      if (msg.includes("factions_holding_pole_uniq")) return "pole-taken";
      throw err;
    }
  }
}
