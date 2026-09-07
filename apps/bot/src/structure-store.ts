import type { Database } from "@factions/db";
import { factions, factionMembers, identityLinks, players, clanNotices, seasons, alphaWeeks } from "@factions/db";
import { and, eq, isNull, isNotNull, inArray, or, asc, sql } from "drizzle-orm";
import { openPassesByVoiceChannel, convertPassesForFullMembersDb } from "@factions/roster/internal";
import { nicknameFor, HOLDING_STATUSES } from "@factions/domain";

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
  /**
   * factionId → discord ids of FULL members, for exactly the given factions —
   * independent of whether the clan has a Discord role id yet, so a
   * brand-new Alpha faction with no structure still gets its members read.
   */
  fullMembersOf(factionIds: number[]): Promise<Map<number, string[]>>;
  /**
   * The faction ids ranked in `alpha_weeks` for the latest closed week
   * (`seasons.week_closed_through`) of every open season. Empty when no
   * week has closed yet for any open season.
   */
  currentAlphaFactionIds(): Promise<Set<number>>;
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
  /** Every open guest pass, keyed by the holding clan's voice channel. Delegates to `openPassesByVoiceChannel`. */
  openGuestPassesByVoiceChannel(now: Date): Promise<Map<string, Set<string>>>;
  /** Stamp `converted_at` on any open pass whose user is now a FULL member of the granting clan. Returns the count. */
  convertGuestPasses(now: Date): Promise<number>;
  /**
   * discordId → the nickname every linked user should have: `[TAG] gamertag`
   * for a FULL member of a holding-status clan, bare gamertag otherwise.
   */
  desiredNicknames(): Promise<Map<string, string>>;
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

  async fullMembersOf(factionIds: number[]): Promise<Map<number, string[]>> {
    const result = new Map<number, string[]>();
    if (factionIds.length === 0) return result;
    const rows = await this.db
      .select({ factionId: factionMembers.factionId, discordId: factionMembers.discordId })
      .from(factionMembers)
      .where(and(inArray(factionMembers.factionId, factionIds), eq(factionMembers.status, "full")))
      .orderBy(asc(factionMembers.factionId), asc(factionMembers.discordId));
    for (const row of rows) {
      if (!result.has(row.factionId)) {
        result.set(row.factionId, []);
      }
      result.get(row.factionId)!.push(row.discordId);
    }
    return result;
  }

  async currentAlphaFactionIds(): Promise<Set<number>> {
    const openSeasons = await this.db
      .select({ id: seasons.id, weekClosedThrough: seasons.weekClosedThrough })
      .from(seasons)
      .where(and(isNull(seasons.endedAt), isNotNull(seasons.weekClosedThrough)));
    const result = new Set<number>();
    for (const season of openSeasons) {
      const rows = await this.db
        .select({ factionId: alphaWeeks.factionId })
        .from(alphaWeeks)
        .where(and(eq(alphaWeeks.seasonId, season.id), eq(alphaWeeks.weekStart, season.weekClosedThrough!)));
      for (const row of rows) result.add(row.factionId);
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

  async openGuestPassesByVoiceChannel(now: Date): Promise<Map<string, Set<string>>> {
    return openPassesByVoiceChannel(this.db, now);
  }

  async convertGuestPasses(now: Date): Promise<number> {
    return convertPassesForFullMembersDb(this.db, now);
  }

  /**
   * ⚠️ One row per link, and the tag is picked DETERMINISTICALLY. Nothing
   * stops a user holding a full membership in two clans at once (two
   * servers), and an unscoped join would then hand out whichever row the
   * planner returned last — a tag that can flap from tick to tick, renaming
   * the same person back and forth forever. The clan with the LOWEST
   * `factions.id` wins, the same tiebreak `actorFor` uses
   * (`orderBy(asc(factions.id)).limit(1)`).
   *
   * The `factions` join carries the holding-status test so a non-holding
   * membership can never out-sort a holding one; such a row comes back with
   * null faction columns and sorts last, leaving the bare gamertag only when
   * there is no holding clan at all.
   */
  async desiredNicknames(): Promise<Map<string, string>> {
    const rows = await this.db
      .select({
        discordId: identityLinks.discordId,
        linkGamertag: identityLinks.gamertag,
        playerGamertag: players.gamertag,
        tag: factions.tag,
      })
      .from(identityLinks)
      .leftJoin(players, eq(players.dayzId, identityLinks.dayzId))
      .leftJoin(
        factionMembers,
        and(eq(factionMembers.discordId, identityLinks.discordId), eq(factionMembers.status, "full")),
      )
      .leftJoin(
        factions,
        and(eq(factions.id, factionMembers.factionId), inArray(factions.status, [...HOLDING_STATUSES])),
      )
      .orderBy(asc(identityLinks.id), sql`${factions.id} asc nulls last`);

    const result = new Map<string, string>();
    for (const row of rows) {
      // First row per link is the winner: lowest holding faction id, else the
      // sole tagless row.
      if (result.has(row.discordId)) continue;
      const gamertag = row.playerGamertag ?? row.linkGamertag;
      result.set(row.discordId, nicknameFor(gamertag, row.tag ?? null));
    }
    return result;
  }
}
