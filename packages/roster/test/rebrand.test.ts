import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, players, admFiles, flagHolds, clanNotices, declarations,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { FLAG_CHANGE_WINDOW_MS } from "@factions/domain";
import { renameDb, cancelRebrandDb, disbandDb } from "../src/writes";
import { freeFlagsDb } from "../src/internal/flag-holds";
import { clanForDb, type ClanView } from "../src/reads";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");

const UID_L = "L".repeat(40);
const UID_O = "O".repeat(40);
const UID_T = "T".repeat(40);

describe("rebrand: starting and cancelling a flag change", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table flag_holds, faction_textures, clan_notices, faction_join_requests, identity_holds, faction_invites, roster_cooldowns, faction_members, declarations, poles, factions, ceremony_participants, ceremonies, claim_drafts, identity_links, players, events, raw_lines, adm_files, faction_events, servers restart identity cascade`);
    });

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true });

    await db.insert(players).values([
      { dayzId: UID_L, gamertag: "Leo", firstSeenAt: now, lastSeenAt: now },
      { dayzId: UID_O, gamertag: "Otto", firstSeenAt: now, lastSeenAt: now },
      { dayzId: UID_T, gamertag: "Theo", firstSeenAt: now, lastSeenAt: now },
    ]);
    await db.insert(identityLinks).values([
      { discordId: "d1", dayzId: UID_L, gamertag: "Leo", verifiedAt: now },
      { discordId: "d2", dayzId: UID_O, gamertag: "Otto", verifiedAt: now },
      { discordId: "d3", dayzId: UID_T, gamertag: "Theo", verifiedAt: now },
    ]);

    const f = await seedFaction(db, {
      serverId, tag: "BEAR", name: "Bears", texture: "Flag_Bear",
      leaderDiscordId: "d1", createdAt: now, activatedAt: now,
    });
    factionId = f.id;
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: UID_L, discordId: "d1", role: "leader", joinedAt: now, status: "full" },
      { factionId, serverId, dayzId: UID_T, discordId: "d3", role: "member", joinedAt: now, status: "full" },
    ]);
  });

  const holds = () => db.select().from(flagHolds).where(eq(flagHolds.factionId, factionId));
  const bear = async () => (await db.select().from(factions).where(eq(factions.id, factionId)))[0]!;

  it("a flag-only rebrand reserves the flag, changes nothing on the clan, and starts no cooldown", async () => {
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" })).toBe("flag-pending");
    const [h] = await holds();
    expect(h).toMatchObject({ texture: "Flag_Wolf", kind: "pending", stampsCooldown: true, until: new Date(now.getTime() + FLAG_CHANGE_WINDOW_MS) });
    expect(await bear()).toMatchObject({ texture: "Flag_Bear", renamedAt: null });
    const [n] = await db.select().from(clanNotices).where(eq(clanNotices.kind, "flag_change_started"));
    expect(n!.payload).toMatchObject({ texture: "Flag_Wolf" });
  });

  it("name plus flag renames now, starts the cooldown now, and leaves the flag pending", async () => {
    expect(await renameDb(db, now, "d1", { name: "Wolves", tag: "WOLF", texture: "Flag_Wolf" })).toBe("flag-pending");
    expect(await bear()).toMatchObject({ name: "Wolves", tag: "WOLF", texture: "Flag_Bear", renamedAt: now });
    expect((await holds())[0]).toMatchObject({ stampsCooldown: false });
  });

  it("refuses a second rebrand while one is pending, even a name-only one", async () => {
    await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" });
    expect(await renameDb(db, now, "d1", { name: "Grizzlies" })).toBe("change-pending");
  });

  it("refuses a flag-only rebrand during the rename cooldown", async () => {
    await db.update(factions).set({ renamedAt: now }).where(eq(factions.id, factionId));
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" })).toBe("cooldown");
    expect(await holds()).toEqual([]);
  });

  it("refuses a flag change for a dormant clan, and refuses a taken or unknown flag", async () => {
    await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "6000.00:100.00:6000.00", x: 6000, z: 6000, leaderDiscordId: "dW", createdAt: now, activatedAt: now });
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" })).toBe("flag-taken");
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_White" })).toBe("bad-flag");
    await db.update(factions).set({ status: "dormant", dormantSince: now, dormantReason: "inactive" }).where(eq(factions.id, factionId));
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Rex" })).toBe("not-active");
  });

  it("refuses a flag change for a clan with no base, since the kit could never deliver it", async () => {
    await db.delete(declarations).where(eq(declarations.ownerFactionId, factionId));
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" })).toBe("no-base");
    expect(await holds()).toEqual([]);
    // A name-only rename needs no base.
    expect(await renameDb(db, now, "d1", { name: "Grizzlies" })).toBe("ok");
  });

  it("disband drops the clan's flag holds, pending and released, and the flags are free at once", async () => {
    await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" });
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Rex", factionId, kind: "released", until: new Date(now.getTime() + 86_400_000), createdAt: now });
    expect(await freeFlagsDb(db, serverId, now)).not.toContain("Flag_Wolf");
    expect(await disbandDb(db, "d1")).toBe("ok");
    expect(await holds()).toEqual([]);
    const free = await freeFlagsDb(db, serverId, now);
    expect(free).toEqual(expect.arrayContaining(["Flag_Wolf", "Flag_Rex", "Flag_Bear"]));
  });

  it("only the leader can rebrand or cancel", async () => {
    expect(await renameDb(db, now, "d3", { name: "Bears", texture: "Flag_Wolf" })).toBe("not-leader");
    await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" });
    expect(await cancelRebrandDb(db, "d3")).toBe("not-leader");
  });

  it("cancel frees the flag at once and costs no cooldown", async () => {
    await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" });
    expect(await cancelRebrandDb(db, "d1")).toBe("ok");
    expect(await holds()).toEqual([]);
    expect(await cancelRebrandDb(db, "d1")).toBe("nothing-pending");
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Rex" })).toBe("flag-pending");
  });

  it("an unchanged submission is still unchanged", async () => {
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Bear" })).toBe("unchanged");
  });

  it("the leader's clan view carries the pending flag and the free pool; a member's does not", async () => {
    await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" });
    const lead = await clanForDb(db, "d1", now);
    expect(lead).toMatchObject({ rebrand: { pending: { texture: "Flag_Wolf" } } });
    expect((lead as ClanView).rebrand!.freeFlags).not.toContain("Flag_Wolf");
    expect(((await clanForDb(db, "d3", now)) as ClanView).rebrand).toBeNull();
  });
});
