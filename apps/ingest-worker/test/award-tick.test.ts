import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, awardGrants, awardUploads, identityLinks, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { awardTick } from "../src/award-tick.js";

const DB_URL = requireTestDatabaseUrl();
const now = new Date("2026-09-22T13:10:00Z");
const FULL = { vest: "PlateCarrierVest_Black", pouches: "PlateCarrierPouches_Green", holster: "PlateCarrierHolster_Camo" };

function fakeUploader(fail = false) {
  const uploaded: string[] = [];
  return {
    uploaded,
    uploadFile: async (_d: string, _f: string, content: string) => { if (fail) throw new Error("nitrado down"); uploaded.push(content); },
    statFile: async () => null,
  };
}

describe("awardTick", () => {
  let db: Database; let serverId = 0;

  beforeEach(async () => {
    db = createClient(DB_URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table award_uploads, award_grants, identity_links, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(identityLinks).values({ discordId: "1", dayzId: "A".repeat(40), gamertag: "Ron", verifiedAt: now });
  });

  const seed = (over: Record<string, unknown> = {}) => db.insert(awardGrants).values({
    awardKey: "plate-carrier", discordId: "1", grantedByDiscordId: "9", reason: "Won",
    grantedAt: now, placeBy: new Date("2026-09-29T00:00:00Z"), picks: FULL,
    posX: "100.00", posY: "5.00", posZ: "200.00", placedAt: now, ...over,
  }).returning();
  const tick = (client = fakeUploader(), at = now) =>
    awardTick(db, { serverId, client, remoteDir: "/custom", fileName: "awards.json", now: at });
  const objects = (content: string) => JSON.parse(content).Objects as { name: string; pos: number[]; customString: string; enableCEPersistency: number }[];

  it("writes one object per picked item at the spot, lifted, respawning, owned by the gamertag", async () => {
    await seed();
    const client = fakeUploader();
    expect(await tick(client)).toMatchObject({ awards: 1, uploaded: true, stamped: 1 });
    const objs = objects(client.uploaded[0]!);
    expect(objs.map((o) => o.name).sort()).toEqual(Object.values(FULL).sort());
    expect(objs[0]).toMatchObject({ pos: [100, 5.25, 200], enableCEPersistency: 0, customString: "Ron" });
  });

  it("writes an empty file, not no file, with nothing to spawn", async () => {
    const client = fakeUploader();
    await tick(client);
    expect(client.uploaded).toEqual(['{"Objects":[]}']);
  });

  it("stamps the clock from the upload: the next restart slot, plus the award's duration", async () => {
    await seed();
    await tick();
    const [g] = await db.select().from(awardGrants);
    expect(g!.liveFrom!.toISOString()).toBe("2026-09-22T14:00:00.000Z");
    expect(g!.expiresAt!.toISOString()).toBe("2026-09-29T14:00:00.000Z");
  });

  it("⚠️ does not stamp when the upload throws", async () => {
    await seed();
    await expect(tick(fakeUploader(true))).rejects.toThrow("nitrado down");
    expect((await db.select().from(awardGrants))[0]!.liveFrom).toBeNull();
  });

  it("stamps on a later sweep when the file is already up, from the stored upload time", async () => {
    await seed();
    await tick();
    await db.update(awardGrants).set({ liveFrom: null, expiresAt: null });
    const later = new Date("2026-09-22T15:30:00Z");
    expect(await tick(fakeUploader(), later)).toMatchObject({ uploaded: false, stamped: 1 });
    expect((await db.select().from(awardGrants))[0]!.liveFrom!.toISOString()).toBe("2026-09-22T14:00:00.000Z");
  });

  it("⚠️ stamping never changes the file, so it never re-uploads", async () => {
    await seed();
    await tick();
    const client = fakeUploader();
    expect(await tick(client)).toMatchObject({ uploaded: false, stamped: 0 });
    expect(client.uploaded).toEqual([]);
  });

  it("never re-stamps a grant that already has a clock", async () => {
    const liveFrom = new Date("2026-09-20T00:00:00Z");
    await seed({ liveFrom, expiresAt: new Date("2026-09-27T00:00:00Z") });
    await tick();
    expect((await db.select().from(awardGrants))[0]!.liveFrom).toEqual(liveFrom);
  });

  it("⚠️ drops the award AWARD_REMOVAL_LEAD_MS before its expiry restart", async () => {
    const expiresAt = new Date("2026-09-29T14:00:00Z");
    await seed({ liveFrom: new Date("2026-09-22T14:00:00Z"), expiresAt });
    const before = fakeUploader();
    await tick(before, new Date("2026-09-29T13:44:59Z"));
    expect(objects(before.uploaded[0]!)).toHaveLength(3);
    const after = fakeUploader();
    await tick(after, new Date("2026-09-29T13:45:00Z"));
    expect(objects(after.uploaded[0]!)).toHaveLength(0);
  });

  it("excludes unplaced, revoked and unlinked grants", async () => {
    await seed({ posX: null, posY: null, posZ: null, placedAt: null });
    await seed({ revokedAt: now });
    await seed({ discordId: "2" });
    const client = fakeUploader();
    expect(await tick(client)).toMatchObject({ awards: 0 });
  });

  it("⚠️ a grant with a slot cleared after placing leaves the file whole, never partly", async () => {
    await seed({ picks: { vest: FULL.vest, pouches: FULL.pouches } });
    const client = fakeUploader();
    expect(await tick(client)).toMatchObject({ awards: 0 });
    expect(objects(client.uploaded[0]!)).toEqual([]);
  });

  it("a pick that has left the catalogue drops the grant, and a grant for an unknown award too", async () => {
    await seed({ picks: { ...FULL, holster: "PlateCarrierHolster_Pink" } });
    await seed({ awardKey: "golden-shovel" });
    expect(await tick()).toMatchObject({ awards: 0 });
  });

  it("⚠️ reports the grants it dropped for a bad pick or an unknown award, rather than drop them silently", async () => {
    const [a] = await seed({ picks: { ...FULL, holster: "PlateCarrierHolster_Pink" } });
    const [b] = await seed({ awardKey: "golden-shovel" });
    await seed();
    expect((await tick()).dropped).toEqual([a!.id, b!.id]);
  });

  it("orders grants by id so the bytes are stable", async () => {
    await db.insert(identityLinks).values({ discordId: "2", dayzId: "B".repeat(40), gamertag: "Ann", verifiedAt: now });
    await seed({ discordId: "2" });
    await seed();
    const client = fakeUploader();
    await tick(client);
    expect(objects(client.uploaded[0]!).map((o) => o.customString)).toEqual(["Ann", "Ann", "Ann", "Ron", "Ron", "Ron"]);
  });
});
