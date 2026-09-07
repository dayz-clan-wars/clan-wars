import { describe, it, expect, beforeAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, successionClaims, factionVotes, factionVoteBallots,
  vaultLocks, vaultHistory, guestPasses, type Database,
} from "../src/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-07T12:00:00Z");
const later = new Date("2026-09-08T12:00:00Z");
const UID = "A".repeat(40);

describe("migration 0028", () => {
  let db: Database; let serverId = 0; let factionId = 0;

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table guest_passes, vault_history, vault_locks, faction_vote_ballots, faction_votes, succession_claims, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    factionId = f!.id;
  });

  it("succession_claims allows one open claim per faction and requires closed_at iff outcome", async () => {
    await db.insert(successionClaims).values({
      factionId, serverId, claimantDayzId: UID, claimantDiscordId: "c1",
      leaderDayzId: UID, leaderDiscordId: "l1", openedAt: now, resolvesAt: later,
    });
    await expect(db.insert(successionClaims).values({
      factionId, serverId, claimantDayzId: UID, claimantDiscordId: "c2",
      leaderDayzId: UID, leaderDiscordId: "l1", openedAt: now, resolvesAt: later,
    })).rejects.toThrow(/succession_claims_open_uniq/u);

    await expect(db.insert(successionClaims).values({
      factionId, serverId, claimantDayzId: UID, claimantDiscordId: "c3",
      leaderDayzId: UID, leaderDiscordId: "l1", openedAt: now, resolvesAt: later,
      closedAt: later, outcome: null,
    })).rejects.toThrow(/succession_claims_closed_iff_outcome/u);
  });

  it("faction_votes allows one open vote per faction and ballots are unique per (vote, dayz_id)", async () => {
    const [v] = await db.insert(factionVotes).values({
      factionId, serverId, nomineeDayzId: UID, nomineeDiscordId: "n1",
      openedByDayzId: UID, leaderDayzId: UID, leaderDiscordId: "l1",
      openedAt: now, closesAt: later, electorateDayzIds: [UID], electorateSize: 1,
    }).returning();
    const voteId = v!.id;

    await expect(db.insert(factionVotes).values({
      factionId, serverId, nomineeDayzId: UID, nomineeDiscordId: "n2",
      openedByDayzId: UID, leaderDayzId: UID, leaderDiscordId: "l1",
      openedAt: now, closesAt: later, electorateDayzIds: [UID], electorateSize: 1,
    })).rejects.toThrow(/faction_votes_open_uniq/u);

    await db.insert(factionVoteBallots).values({ voteId, dayzId: UID, castAt: now });
    await expect(db.insert(factionVoteBallots).values({ voteId, dayzId: UID, castAt: now }))
      .rejects.toThrow(/faction_vote_ballots_uniq/u);
  });

  it("vault_locks rejects a non-digit code and an invalid min_role", async () => {
    await expect(db.insert(vaultLocks).values({
      factionId, name: "Main", code: "ab12", minRole: "member", createdByDayzId: UID, createdAt: now,
    })).rejects.toThrow(/vault_locks_code_digits/u);

    await expect(db.insert(vaultLocks).values({
      factionId, name: "Main", code: "1234", minRole: "guest", createdByDayzId: UID, createdAt: now,
    })).rejects.toThrow(/vault_locks_min_role_valid/u);
  });

  it("deleting a lock nulls vault_history.lock_id and keeps the row", async () => {
    const [lock] = await db.insert(vaultLocks).values({
      factionId, name: "Shed", code: "1234", minRole: "member", createdByDayzId: UID, createdAt: now,
    }).returning();
    await db.insert(vaultHistory).values({
      factionId, lockId: lock!.id, lockName: "Shed", action: "added", dayzId: UID, at: now,
    });
    await db.delete(vaultLocks).where(eq(vaultLocks.id, lock!.id));
    const rows = await db.select().from(vaultHistory).where(eq(vaultHistory.lockName, "Shed"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lockId).toBeNull();
  });

  it("deleting the faction cascades succession_claims, faction_votes, faction_vote_ballots, vault_locks, vault_history and guest_passes", async () => {
    const [f] = await db.insert(factions).values({ serverId, name: "Wolves", tag: "WLF", texture: "Flag_Wolf", status: "active", leaderDiscordId: "d2", createdAt: now }).returning();
    const cascadeFactionId = f!.id;

    await db.insert(successionClaims).values({
      factionId: cascadeFactionId, serverId, claimantDayzId: UID, claimantDiscordId: "c1",
      leaderDayzId: UID, leaderDiscordId: "l1", openedAt: now, resolvesAt: later,
    });
    const [v] = await db.insert(factionVotes).values({
      factionId: cascadeFactionId, serverId, nomineeDayzId: UID, nomineeDiscordId: "n1",
      openedByDayzId: UID, leaderDayzId: UID, leaderDiscordId: "l1",
      openedAt: now, closesAt: later, electorateDayzIds: [UID], electorateSize: 1,
    }).returning();
    await db.insert(factionVoteBallots).values({ voteId: v!.id, dayzId: UID, castAt: now });
    const [lock] = await db.insert(vaultLocks).values({
      factionId: cascadeFactionId, name: "Vault", code: "5678", minRole: "member", createdByDayzId: UID, createdAt: now,
    }).returning();
    await db.insert(vaultHistory).values({
      factionId: cascadeFactionId, lockId: lock!.id, lockName: "Vault", action: "added", dayzId: UID, at: now,
    });
    await db.insert(guestPasses).values({
      factionId: cascadeFactionId, discordUserId: "g1", grantedByDiscordId: "d2", grantedAt: now, expiresAt: later,
    });

    await db.delete(factions).where(eq(factions.id, cascadeFactionId));

    expect(await db.select().from(successionClaims).where(eq(successionClaims.factionId, cascadeFactionId))).toEqual([]);
    expect(await db.select().from(factionVotes).where(eq(factionVotes.factionId, cascadeFactionId))).toEqual([]);
    expect(await db.select().from(factionVoteBallots).where(eq(factionVoteBallots.voteId, v!.id))).toEqual([]);
    expect(await db.select().from(vaultLocks).where(eq(vaultLocks.factionId, cascadeFactionId))).toEqual([]);
    expect(await db.select().from(vaultHistory).where(eq(vaultHistory.factionId, cascadeFactionId))).toEqual([]);
    expect(await db.select().from(guestPasses).where(eq(guestPasses.factionId, cascadeFactionId))).toEqual([]);
  });
});
