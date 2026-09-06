import type { Database } from "@factions/db";
import { factions, factionMembers, identityLinks, clanNotices } from "@factions/db";
import { and, eq, isNull, isNotNull, inArray, or, asc } from "drizzle-orm";

export type StructureRow = {
  id: number;
  serverId: number;
  name: string;
  tag: string;
  status: string;
  roleId: string | null;
  textChannelId: string | null;
  voiceChannelId: string | null;
};

export interface StructureStore {
  /** active or dormant with at least one id null — needs creating (or finishing). */
  clansNeedingStructure(): Promise<StructureRow[]>;
  /** lapsed or disbanded with at least one id set — needs tearing down. */
  clansToTearDown(): Promise<StructureRow[]>;
  /** active or dormant with all three ids set — the steady state, for rename drift and role membership. */
  clansWithStructure(): Promise<StructureRow[]>;
  setRoleId(factionId: number, id: string | null): Promise<void>;
  setTextChannelId(factionId: number, id: string | null): Promise<void>;
  setVoiceChannelId(factionId: number, id: string | null): Promise<void>;
  /** factionId → discord ids of FULL members, for every clan with a role id. */
  fullMembersByClan(): Promise<Map<number, string[]>>;
  /** Every identity_links.discord_id. */
  linkedDiscordIds(): Promise<Set<string>>;
  /**
   * Stamp `failed_at` on the clan's still-queued CHANNEL notices. Called at
   * teardown, before the text-channel column is nulled: once the channel is
   * gone those rows can never post, and `readUnposted` coalesces on that
   * column, so leaving them would strand them — unpostable, unfailed, and
   * counted forever by `countUnpostedNotices`. Returns the row count.
   */
  failChannelNotices(factionId: number, at: Date): Promise<number>;
}

export class PgStructureStore implements StructureStore {
  constructor(private readonly db: Database) {}

  async clansNeedingStructure(): Promise<StructureRow[]> {
    return this.db
      .select({
        id: factions.id,
        serverId: factions.serverId,
        name: factions.name,
        tag: factions.tag,
        status: factions.status,
        roleId: factions.discordRoleId,
        textChannelId: factions.discordTextChannelId,
        voiceChannelId: factions.discordVoiceChannelId,
      })
      .from(factions)
      .where(
        and(
          inArray(factions.status, ["active", "dormant"]),
          or(
            isNull(factions.discordRoleId),
            isNull(factions.discordTextChannelId),
            isNull(factions.discordVoiceChannelId),
          ),
        ),
      )
      .orderBy(asc(factions.id));
  }

  async clansToTearDown(): Promise<StructureRow[]> {
    return this.db
      .select({
        id: factions.id,
        serverId: factions.serverId,
        name: factions.name,
        tag: factions.tag,
        status: factions.status,
        roleId: factions.discordRoleId,
        textChannelId: factions.discordTextChannelId,
        voiceChannelId: factions.discordVoiceChannelId,
      })
      .from(factions)
      .where(
        and(
          inArray(factions.status, ["lapsed", "disbanded"]),
          or(
            isNotNull(factions.discordRoleId),
            isNotNull(factions.discordTextChannelId),
            isNotNull(factions.discordVoiceChannelId),
          ),
        ),
      )
      .orderBy(asc(factions.id));
  }

  async clansWithStructure(): Promise<StructureRow[]> {
    return this.db
      .select({
        id: factions.id,
        serverId: factions.serverId,
        name: factions.name,
        tag: factions.tag,
        status: factions.status,
        roleId: factions.discordRoleId,
        textChannelId: factions.discordTextChannelId,
        voiceChannelId: factions.discordVoiceChannelId,
      })
      .from(factions)
      .where(
        and(
          inArray(factions.status, ["active", "dormant"]),
          isNotNull(factions.discordRoleId),
          isNotNull(factions.discordTextChannelId),
          isNotNull(factions.discordVoiceChannelId),
        ),
      )
      .orderBy(asc(factions.id));
  }

  async setRoleId(factionId: number, id: string | null): Promise<void> {
    await this.db.update(factions).set({ discordRoleId: id }).where(eq(factions.id, factionId));
  }

  async setTextChannelId(factionId: number, id: string | null): Promise<void> {
    await this.db.update(factions).set({ discordTextChannelId: id }).where(eq(factions.id, factionId));
  }

  async setVoiceChannelId(factionId: number, id: string | null): Promise<void> {
    await this.db.update(factions).set({ discordVoiceChannelId: id }).where(eq(factions.id, factionId));
  }

  async fullMembersByClan(): Promise<Map<number, string[]>> {
    const rows = await this.db
      .select({
        factionId: factions.id,
        discordId: factionMembers.discordId,
      })
      .from(factions)
      .innerJoin(factionMembers, eq(factions.id, factionMembers.factionId))
      .where(
        and(
          isNotNull(factions.discordRoleId),
          eq(factionMembers.status, "full"),
        ),
      )
      .orderBy(asc(factions.id), asc(factionMembers.discordId));

    const result = new Map<number, string[]>();
    for (const row of rows) {
      if (!result.has(row.factionId)) {
        result.set(row.factionId, []);
      }
      result.get(row.factionId)!.push(row.discordId);
    }
    return result;
  }

  async linkedDiscordIds(): Promise<Set<string>> {
    const rows = await this.db.select({ discordId: identityLinks.discordId }).from(identityLinks);
    return new Set(rows.map((r) => r.discordId));
  }

  async failChannelNotices(factionId: number, at: Date): Promise<number> {
    const rows = await this.db
      .update(clanNotices)
      .set({ failedAt: at })
      .where(
        and(
          eq(clanNotices.factionId, factionId),
          eq(clanNotices.target, "channel"),
          isNull(clanNotices.postedAt),
          isNull(clanNotices.failedAt),
        ),
      )
      .returning({ id: clanNotices.id });
    return rows.length;
  }
}
