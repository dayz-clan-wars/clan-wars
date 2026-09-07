import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factionMembers, successionClaims, factionVotes, factionVoteBallots, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { leadershipTick } from "../src/leadership-tick.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

const D = { L1: "dL1", C1: "dC1", L2: "dL2", N2: "dN2" };
const UID = { L1: "L1".repeat(20), C1: "C1".repeat(20), L2: "L2".repeat(20), N2: "N2".repeat(20) };

describe("leadershipTick", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_vote_ballots, faction_votes, succession_claims, faction_members, declarations, poles, factions, clan_notices, events, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  it("resolves one claim past resolves_at and closes one vote past closes_at, in one call, with counts reported", async () => {
    // Clan 1: an open claim resolving in the past succeeds.
    const f1 = await seedFaction(db, { serverId, tag: "ONE", texture: "Flag_One", createdAt: ago(1_000_000), poleKey: "1000.00:100.00:1000.00" });
    await db.insert(factionMembers).values([
      { factionId: f1.id, serverId, dayzId: UID.L1, discordId: D.L1, role: "leader", joinedAt: ago(500_000), status: "full" },
      { factionId: f1.id, serverId, dayzId: UID.C1, discordId: D.C1, role: "member", joinedAt: ago(500_000), status: "full" },
    ]);
    await db.insert(successionClaims).values({
      factionId: f1.id, serverId,
      claimantDayzId: UID.C1, claimantDiscordId: D.C1,
      leaderDayzId: UID.L1, leaderDiscordId: D.L1,
      openedAt: ago(200_000), resolvesAt: ago(1),
    });

    // Clan 2: an open vote whose closes_at has passed, with no electorate, fails on the spot.
    const f2 = await seedFaction(db, { serverId, tag: "TWO", texture: "Flag_Two", createdAt: ago(1_000_000), poleKey: "2000.00:100.00:2000.00" });
    await db.insert(factionMembers).values([
      { factionId: f2.id, serverId, dayzId: UID.L2, discordId: D.L2, role: "leader", joinedAt: ago(500_000), status: "full" },
      { factionId: f2.id, serverId, dayzId: UID.N2, discordId: D.N2, role: "member", joinedAt: ago(500_000), status: "full" },
    ]);
    await db.insert(factionVotes).values({
      factionId: f2.id, serverId,
      nomineeDayzId: UID.N2, nomineeDiscordId: D.N2,
      openedByDayzId: UID.N2,
      leaderDayzId: UID.L2, leaderDiscordId: D.L2,
      openedAt: ago(200_000), closesAt: ago(1),
      electorateDayzIds: [], electorateSize: 0,
    });

    const result = await leadershipTick(db, now);
    expect(result).toEqual({ succeeded: 1, voided: 0, passed: 0, failed: 1 });

    const [claim] = await db.select().from(successionClaims).where(eq(successionClaims.factionId, f1.id));
    expect(claim!.outcome).toBe("succeeded");
    const [member] = await db.select({ role: factionMembers.role }).from(factionMembers)
      .where(eq(factionMembers.discordId, D.C1));
    expect(member!.role).toBe("leader");

    const [vote] = await db.select().from(factionVotes).where(eq(factionVotes.factionId, f2.id));
    expect(vote!.result).toBe("failed");
  });

  it("reports zeros and writes nothing when nothing is due", async () => {
    expect(await leadershipTick(db, now)).toEqual({ succeeded: 0, voided: 0, passed: 0, failed: 0 });
  });
});
