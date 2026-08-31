import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, ceremonies, ceremonyParticipants, factions, factionMembers, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgFactionStore } from "../src/faction-store.js";
import { handleFactionClaim, handleClaimConfirm, type FactionDeps } from "../src/faction-commands.js";

const URL = requireTestDatabaseUrl();
const UIDS = ["A", "B", "C"].map((c) => c.repeat(40));
const now = new Date("2026-08-31T12:00:00Z");

describe("faction claim", () => {
  let db: Database;
  let deps: FactionDeps;
  let serverId = 0;
  let ceremonyId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_members, claim_drafts, factions, ceremony_participants, ceremonies, servers restart identity cascade`);
    deps = { store: new PgFactionStore(db), now: () => now, reservationTtlMs: 86_400_000 };
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [c] = await db.insert(ceremonies).values({
      serverId, poleKey: "1:2:3", x: "1.00", y: "2.00", z: "3.00",
      windowStart: now, windowEnd: now,
      status: "provisional", detectedAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
    }).returning();
    ceremonyId = c!.id;
    await db.insert(ceremonyParticipants).values(UIDS.map((dayzId, i) => ({
      ceremonyId, dayzId, discordId: `10${i}`, gamertag: `P${i}`,
    })));
  });

  const input = { name: "The Bears", tag: "BEAR", texture: "Flag_Bear" };

  it("prompts a participant to prune the roster", async () => {
    const r = await handleFactionClaim(deps, "100", input);
    expect(r.prompt?.ceremonyId).toBe(ceremonyId);
    expect(r.prompt?.participants).toHaveLength(3);
  });

  it("refuses someone who was not at the ceremony", async () => {
    // §5's defense against claiming a ceremony you did not attend.
    const r = await handleFactionClaim(deps, "999", input);
    expect(r.prompt).toBeUndefined();
    expect(r.content).toMatch(/no ceremony/i);
  });

  it("refuses a flag outside the pool", async () => {
    const r = await handleFactionClaim(deps, "100", { ...input, texture: "Flag_White" });
    expect(r.content).toMatch(/not a claimable flag/i);
  });

  it("refuses a flag another faction holds", async () => {
    await db.insert(factions).values({
      serverId, name: "Other", tag: "OTH", texture: "Flag_Bear", poleKey: "9:9:9",
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "900", createdAt: now,
    });
    const r = await handleFactionClaim(deps, "100", input);
    expect(r.content).toMatch(/already taken/i);
  });

  it("reserves the faction on confirm, with the claimant as leader, carrying the ceremony's coordinates", async () => {
    await handleFactionClaim(deps, "100", input);
    const r = await handleClaimConfirm(deps, "100", ceremonyId, UIDS);
    expect(r.content).toMatch(/reserved/i);
    const [f] = await db.select().from(factions);
    expect(f?.status).toBe("reserved");
    expect(f?.reservedUntil).toEqual(new Date(now.getTime() + 86_400_000));
    expect(f?.x).toBe("1.00");
    expect(f?.y).toBe("2.00");
    expect(f?.z).toBe("3.00");
    const members = await db.select().from(factionMembers).where(eq(factionMembers.factionId, f!.id));
    expect(members).toHaveLength(3);
    expect(members.find((m) => m.discordId === "100")?.role).toBe("leader");
  });

  it("writes only the kept participants to the roster", async () => {
    // The claimant prunes: a stranger who wandered into the ritual must not
    // land on the founding roster.
    await handleFactionClaim(deps, "100", input);
    await handleClaimConfirm(deps, "100", ceremonyId, [UIDS[0]!, UIDS[1]!]);
    const [f] = await db.select().from(factions);
    expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, f!.id))).toHaveLength(2);
  });

  it("refuses to prune the claimant out of their own faction", async () => {
    await handleFactionClaim(deps, "100", input);
    const r = await handleClaimConfirm(deps, "100", ceremonyId, [UIDS[1]!, UIDS[2]!]);
    expect(r.content).toMatch(/cannot remove yourself/i);
    expect(await db.select().from(factions)).toHaveLength(0);
  });

  it("marks the ceremony claimed", async () => {
    await handleFactionClaim(deps, "100", input);
    await handleClaimConfirm(deps, "100", ceremonyId, UIDS);
    const [c] = await db.select().from(ceremonies);
    expect(c?.status).toBe("claimed");
  });

  it("refuses a second claim of the same ceremony", async () => {
    // Two participants confirming concurrently: the loser must be told, not
    // handed a stack trace, and must not create a second faction.
    await handleFactionClaim(deps, "100", input);
    await handleClaimConfirm(deps, "100", ceremonyId, UIDS);
    const r = await handleClaimConfirm(deps, "101", ceremonyId, UIDS);
    expect(r.content).toMatch(/already been claimed/i);
    expect(await db.select().from(factions)).toHaveLength(1);
  });

  it("refuses to claim an expired ceremony", async () => {
    await db.update(ceremonies).set({ status: "expired" }).where(eq(ceremonies.id, ceremonyId));
    const r = await handleFactionClaim(deps, "100", input);
    expect(r.content).toMatch(/no ceremony/i);
  });

  it("refuses to reserve at a pole another faction already holds", async () => {
    // A ceremony can be settled at a pole a faction already holds — the
    // third scarcity rule, factions_holding_pole_uniq, must surface as a
    // sentence, not an unhandled exception.
    await db.insert(factions).values({
      serverId, name: "Holders", tag: "HOLD", texture: "Flag_Wolf", poleKey: "1:2:3",
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "900", createdAt: now,
    });
    await handleFactionClaim(deps, "100", input);
    const r = await handleClaimConfirm(deps, "100", ceremonyId, UIDS);
    expect(r.content).toMatch(/pole already belongs to a faction/i);
    // The ceremony must not be left claimed with no faction to show for it.
    const [f] = await db.select().from(factions).where(eq(factions.leaderDiscordId, "100"));
    expect(f).toBeUndefined();
  });

  it("saves a separate draft per participant of one ceremony", async () => {
    await handleFactionClaim(deps, "100", input);
    await handleFactionClaim(deps, "101", { name: "The Wolves", tag: "WOLF", texture: "Flag_Wolf" });
    const r = await handleClaimConfirm(deps, "101", ceremonyId, UIDS);
    expect(r.content).toMatch(/reserved/i);
    const [f] = await db.select().from(factions);
    expect(f?.name).toBe("The Wolves");
  });
});
