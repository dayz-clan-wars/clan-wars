import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, boosterKits, boosterKitUploads, discordBoosters, identityLinks, factionMembers,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { seedFaction } from "./seed.js";
import { boosterKitTick } from "../src/booster-kit-tick.js";

const DB_URL = requireTestDatabaseUrl();
const now = new Date("2026-09-19T12:00:00Z");

/**
 * Records what was sent instead of talking to Nitrado. statFile returns null,
 * which is the "no baseline yet" path syncProjection already handles.
 */
function fakeUploader() {
  const uploaded: { remoteDir: string; fileName: string; content: string }[] = [];
  return {
    uploaded,
    uploadFile: async (remoteDir: string, fileName: string, content: string) => {
      uploaded.push({ remoteDir, fileName, content });
    },
    statFile: async () => null,
  };
}

describe("boosterKitTick", () => {
  let db: Database;
  let serverId = 0;

  /**
   * One booster who satisfies every eligibility condition, so each test can
   * remove exactly one of them and assert the kit disappears.
   */
  const seedEligibleBooster = async (a: {
    discordId: string; gamertag: string; pos: [number, number, number] | null;
    mask?: string; jacket?: string;
  }) => {
    await db.insert(discordBoosters).values({ discordId: a.discordId, premiumSince: now, observedAt: now });
    await db.insert(identityLinks).values({
      discordId: a.discordId, dayzId: a.discordId.padStart(40, "A"), gamertag: a.gamertag, verifiedAt: now,
    });
    await db.insert(boosterKits).values({
      discordId: a.discordId,
      posX: a.pos ? a.pos[0].toFixed(2) : null,
      posY: a.pos ? a.pos[1].toFixed(2) : null,
      posZ: a.pos ? a.pos[2].toFixed(2) : null,
      mask: a.mask ?? null, jacket: a.jacket ?? null,
    });
  };

  const tick = (client: { uploadFile: (d: string, f: string, c: string) => Promise<void>; statFile: () => Promise<null> }) =>
    boosterKitTick(db, { serverId, client, remoteDir: "/custom", fileName: "booster-kits.json", now });

  beforeEach(async () => {
    db = createClient(DB_URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table booster_kit_uploads, booster_kits, discord_boosters, identity_links,
        faction_members, travel_uploads, supply_uploads, declarations, poles, events, adm_files, factions, servers
        restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  it("includes a booster who is boosting, linked, placed and has an item", async () => {
    await seedEligibleBooster({ discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "BalaclavaMask_Black" });
    const client = fakeUploader();
    const r = await tick(client);
    expect(r.kits).toBe(1);
    expect(client.uploaded).toHaveLength(1);
    const objects = JSON.parse(client.uploaded[0]!.content).Objects;
    expect(objects).toHaveLength(1);
    // ⚠️ x, altitude, z straight through, as numbers — a string concatenation
    // here is what a missing Number() looks like.
    expect(objects[0].pos).toEqual([1, 2, 3]);
    expect(objects[0].name).toBe("BalaclavaMask_Black");
    expect(objects[0].customString).toBe("Bob");
  });

  it("excludes a booster who stopped boosting", async () => {
    await seedEligibleBooster({ discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "BalaclavaMask_Black" });
    await db.delete(discordBoosters).where(eq(discordBoosters.discordId, "1"));
    const client = fakeUploader();
    const r = await tick(client);
    expect(r.kits).toBe(0);
    expect(client.uploaded[0]!.content).toBe(`{"Objects":[]}`);
  });

  it("excludes a booster who unlinked their character", async () => {
    await seedEligibleBooster({ discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "BalaclavaMask_Black" });
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "1"));
    const client = fakeUploader();
    const r = await tick(client);
    expect(r.kits).toBe(0);
    expect(client.uploaded[0]!.content).toBe(`{"Objects":[]}`);
  });

  it("excludes a kit that was configured but never placed", async () => {
    await seedEligibleBooster({ discordId: "1", gamertag: "Bob", pos: null, mask: "BalaclavaMask_Black" });
    const client = fakeUploader();
    const r = await tick(client);
    expect(r.kits).toBe(0);
    expect(client.uploaded[0]!.content).toBe(`{"Objects":[]}`);
  });

  it("excludes a kit with every slot empty", async () => {
    await seedEligibleBooster({ discordId: "1", gamertag: "Bob", pos: [1, 2, 3] });
    const client = fakeUploader();
    const r = await tick(client);
    expect(r.kits).toBe(0);
    expect(client.uploaded[0]!.content).toBe(`{"Objects":[]}`);
  });

  it("skips a class name that has left the catalogue and still spawns the rest", async () => {
    await seedEligibleBooster({ discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "NotInCatalogue", jacket: "GorkaEJacket_Summer" });
    const client = fakeUploader();
    const r = await tick(client);
    expect(r.kits).toBe(1);
    const names = JSON.parse(client.uploaded[0]!.content).Objects.map((o: { name: string }) => o.name);
    expect(names).not.toContain("NotInCatalogue");
    expect(names).toContain("GorkaEJacket_Summer");
  });

  it("adds the clan armband for a booster on a full roster, and none for a booster in no clan", async () => {
    const f = await seedFaction(db, { serverId, tag: "COK", texture: "Flag_Wolf", createdAt: now });
    await seedEligibleBooster({ discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "BalaclavaMask_Black" });
    await seedEligibleBooster({ discordId: "2", gamertag: "Ann", pos: [4, 5, 6], mask: "BalaclavaMask_Black" });
    await db.insert(factionMembers).values({
      factionId: f.id, serverId, dayzId: "1".padStart(40, "A"), discordId: "1",
      role: "member", joinedAt: now, status: "full",
    });
    const client = fakeUploader();
    await tick(client);
    const objects = JSON.parse(client.uploaded[0]!.content).Objects as { name: string; customString: string }[];
    expect(objects.filter((o) => o.customString === "Bob").map((o) => o.name)).toEqual(["BalaclavaMask_Black", "Armband_Wolf"]);
    expect(objects.filter((o) => o.customString === "Ann").map((o) => o.name)).toEqual(["BalaclavaMask_Black"]);
  });

  it("orders kits by discord id regardless of insertion order", async () => {
    await seedEligibleBooster({ discordId: "2", gamertag: "Zed", pos: [1, 2, 3], mask: "BalaclavaMask_Black" });
    await seedEligibleBooster({ discordId: "1", gamertag: "Abe", pos: [4, 5, 6], mask: "BalaclavaMask_Black" });
    const client = fakeUploader();
    await tick(client);
    const tags = JSON.parse(client.uploaded[0]!.content).Objects.map((o: { customString: string }) => o.customString);
    expect(tags).toEqual(["Abe", "Zed"]);
  });

  it("does not re-upload when nothing changed", async () => {
    await seedEligibleBooster({ discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "BalaclavaMask_Black" });
    const client = fakeUploader();
    expect((await tick(client)).uploaded).toBe(true);
    expect((await tick(client)).uploaded).toBe(false);
    expect(client.uploaded).toHaveLength(1);
  });

  it("retries after a failed upload", async () => {
    await seedEligibleBooster({ discordId: "1", gamertag: "Bob", pos: [1, 2, 3], mask: "BalaclavaMask_Black" });
    const failing = { uploadFile: async () => { throw new Error("nitrado down"); }, statFile: async () => null };
    await expect(tick(failing)).rejects.toThrow("nitrado down");
    // The hash never advanced, so nothing is remembered and the next tick sends.
    expect(await db.select().from(boosterKitUploads).where(eq(boosterKitUploads.serverId, serverId))).toHaveLength(0);
    const ok = fakeUploader();
    expect((await tick(ok)).uploaded).toBe(true);
  });
});
