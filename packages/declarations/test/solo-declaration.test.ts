import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, factionMembers, events, admFiles, poles, identityLinks, type Database } from "@factions/db";
import { SOLO_LAPSE_MS, RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { raisedPolesFor, declareSolo, lapseSolos, declarationForPlayer } from "../src/store";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const P = "5000.00:100.00:5000.00";

describe("solo declarations", () => {
  let db: Database; let serverId = 0; let admFileId = 0; let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table declarations, poles, faction_members, factions, identity_links, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id; line = 0;
    await db.insert(poles).values({ serverId, map: "livonia", poleKey: P, x: "5000.00", y: "100.00", z: "5000.00", currentTexture: "Flag_White", flagRaised: true, firstSeenAt: now, lastSeenAt: now, graceUntil: now });
  });

  const raise = (dayzId: string, at: Date, poleKey = P) => db.insert(events).values({
    serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: at,
    payload: { dayzId, gamertag: "G", texture: "Flag_White", poleKey, pole: { x: 5000, y: 100, z: 5000 } },
  });

  it("offers only poles the player has raised at, newest first, one per pole", async () => {
    await raise("A", ago(2000)); await raise("A", ago(1000)); await raise("B", ago(500));
    const offered = await raisedPolesFor(db, serverId, "A");
    expect(offered).toHaveLength(1);
    expect(offered[0]!.occurredAt.getTime()).toBe(ago(1000).getTime());
  });

  it("declares, citing the newest raise as evidence", async () => {
    await raise("A", ago(1000));
    expect(await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: now })).toEqual({ ok: true, id: expect.any(Number) });
    expect(await declarationForPlayer(db, serverId, "A")).toMatchObject({ poleKey: P });
  });

  it("refuses a pole the player never raised at", async () => {
    expect(await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: now })).toEqual({ ok: false, reason: "no-raise" });
  });

  it("refuses a player who is in a clan — their declaration is the clan's", async () => {
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: "A", discordId: "d1", role: "leader", joinedAt: now });
    await raise("A", ago(1000));
    expect(await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: now })).toEqual({ ok: false, reason: "in-clan" });
  });

  it("a PENDING member may still declare a solo base — promotion, not acceptance, is what releases it", async () => {
    const [f] = await db.insert(factions).values({ serverId, name: "Wolves", tag: "WOLF", texture: "Flag_Wolf", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    await db.insert(factionMembers).values({
      factionId: f!.id, serverId, dayzId: "A", discordId: "d1", role: "member", joinedAt: now,
      status: "pending", pendingSince: now,
    });
    await raise("A", ago(1000));
    expect(await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: now })).toEqual({ ok: true, id: expect.any(Number) });
  });

  it("lapses after 7 days without the declarant's raise, and only theirs", async () => {
    await raise("A", ago(SOLO_LAPSE_MS + 1));
    await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: ago(SOLO_LAPSE_MS + 1) });
    await raise("STRANGER", ago(1000));
    expect(await lapseSolos(db, serverId, now)).toEqual([{ dayzId: "A", poleKey: P, discordId: null }]);
    expect(await declarationForPlayer(db, serverId, "A")).toBeNull();
    const [p] = await db.select().from(poles).where(eq(poles.poleKey, P));
    expect(p!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);
  });

  it("returns the linked discord id for a lapsed declarant, and null for an unlinked one", async () => {
    await db.insert(identityLinks).values({
      discordId: "d-A", dayzId: "A", gamertag: "Steve", verifiedAt: now,
    });
    await raise("A", ago(SOLO_LAPSE_MS + 1));
    await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: ago(SOLO_LAPSE_MS + 1) });
    expect(await lapseSolos(db, serverId, now)).toEqual([{ dayzId: "A", poleKey: P, discordId: "d-A" }]);
  });

  it("⚠️ does not lapse a fresh declaration citing an old raise", async () => {
    // The clock starts at declaring, not at the evidence. A solo may declare
    // today from a raise the log recorded a month ago; lapsing them on the
    // next tick would hand them a base that never existed.
    await raise("A", ago(SOLO_LAPSE_MS * 4));
    await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: ago(1000) });
    expect(await lapseSolos(db, serverId, now)).toEqual([]);
    expect(await declarationForPlayer(db, serverId, "A")).toMatchObject({ poleKey: P });
  });

  it("does not lapse a declarant who raised inside the window", async () => {
    await raise("A", ago(SOLO_LAPSE_MS + 1));
    await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: ago(SOLO_LAPSE_MS + 1) });
    await raise("A", ago(1000));
    expect(await lapseSolos(db, serverId, now)).toEqual([]);
  });
});
