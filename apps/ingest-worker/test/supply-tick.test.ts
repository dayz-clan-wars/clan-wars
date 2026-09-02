import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, supplyUploads, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { loadTemplate } from "../src/supplies.js";
import { supplyTick } from "../src/supply-tick.js";

const DB_URL = requireTestDatabaseUrl();
const RAW = JSON.parse(readFileSync(new URL("../assets/flag-supplies.template.json", import.meta.url), "utf8"));
const offsets = loadTemplate(RAW);
const now = new Date("2026-09-01T12:00:00Z");

describe("supplyTick", () => {
  let db: Database;
  let serverId = 0;

  const seedServer = async (name: string) => {
    const [s] = await db.insert(servers).values({ name, map: "sakhal", clockOffsetMs: 0 }).returning();
    return s!.id;
  };

  const seedFaction = async (opts: {
    tag: string; texture: string; x: string; y: string; z: string; status: string; serverId?: number;
  }) => {
    const [f] = await db.insert(factions).values({
      serverId: opts.serverId ?? serverId,
      name: opts.tag, tag: opts.tag, texture: opts.texture,
      poleKey: `${opts.x}:${opts.y}:${opts.z}`,
      x: opts.x, y: opts.y, z: opts.z,
      status: opts.status, leaderDiscordId: "d1", createdAt: now,
      // The factions_reserved_has_deadline check rejects a reserved row
      // without one.
      reservedUntil: opts.status === "reserved" ? new Date("2026-09-08T12:00:00Z") : null,
    }).returning();
    return f!;
  };

  beforeEach(async () => {
    db = createClient(DB_URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table supply_uploads, factions, servers restart identity cascade`);
    });
    serverId = await seedServer("S");
  });

  it("uploads the kit for a holding faction", async () => {
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    const uploads: { dir: string; name: string; body: string }[] = [];
    const client = { uploadFile: async (dir: string, name: string, body: string) => { uploads.push({ dir, name, body }); } };

    const r = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(r).toEqual({ factions: 1, uploaded: true });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.dir).toBe("/d");
    expect(uploads[0]!.name).toBe("f.json");
    const parsed = JSON.parse(uploads[0]!.body);
    expect(parsed.Objects).toHaveLength(103);
    expect(parsed.Objects.every((o: any) => o.customString === "COK")).toBe(true);
  });

  it("does not upload again when nothing changed", async () => {
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    let calls = 0;
    const client = { uploadFile: async () => { calls++; } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    const second = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(calls).toBe(1);
    expect(second.uploaded).toBe(false);
    expect(second.factions).toBe(1);
  });

  it("uploads again when a faction's texture changes", async () => {
    const f = await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    let calls = 0;
    const client = { uploadFile: async () => { calls++; } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    await db.update(factions).set({ texture: "Flag_Wolf" }).where(eq(factions.id, f.id));
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(calls).toBe(2);
  });

  it("drops a faction that stopped holding", async () => {
    const f = await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    const bodies: string[] = [];
    const client = { uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    await db.update(factions).set({ status: "disbanded", reservedUntil: null }).where(eq(factions.id, f.id));
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    // The kit must stop respawning: the file is now empty, not stale.
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1]!)).toEqual({ Objects: [] });
  });

  it("does not advance the hash when the upload fails", async () => {
    // ⚠️ THE retry property. If the hash advanced on failure, a single
    // Nitrado outage would leave the server permanently missing supplies
    // with nothing to retry it. Delete the success-only hash write and this
    // test must go red.
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    let calls = 0;
    const failing = { uploadFile: async () => { calls++; throw new Error("nitrado down"); } };
    await expect(supplyTick(db, { serverId, client: failing, offsets, remoteDir: "/d", fileName: "f.json", now })).rejects.toThrow(/nitrado down/);
    expect(await db.select().from(supplyUploads)).toHaveLength(0);

    const ok = { uploadFile: async () => { calls++; } };
    const retry = await supplyTick(db, { serverId, client: ok, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(retry.uploaded).toBe(true);
    expect(calls).toBe(2);
  });

  it("reads numeric coordinates as numbers, not strings", async () => {
    // ⚠️ factions.x/y/z are Postgres numeric, which Drizzle returns as
    // STRINGS. "5551.69" + 0.898 is "5551.690.898". Without Number() every
    // coordinate in the file is corrupt.
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    const bodies: string[] = [];
    const client = { uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    const objects = JSON.parse(bodies[0]!).Objects;
    // Without this the loop below asserts nothing on an empty file, so any
    // mutation that drops the faction turns this test green instead of red.
    expect(objects).toHaveLength(103);
    for (const o of objects) {
      for (const p of o.pos) expect(typeof p).toBe("number");
      expect(Number.isFinite(o.pos[0])).toBe(true);
    }
  });

  it("ignores factions on another server", async () => {
    // Both servers hold a faction, so this pins "ours kept, theirs dropped"
    // rather than the weaker "an otherwise-empty file stays empty".
    const other = await seedServer("other");
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    await seedFaction({ tag: "OTH", texture: "Flag_Wolf", x: "1", y: "2", z: "3", status: "active", serverId: other });
    const bodies: string[] = [];
    const client = { uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    const objects = JSON.parse(bodies[0]!).Objects;
    expect(objects).toHaveLength(103);
    expect([...new Set(objects.map((o: any) => o.customString))]).toEqual(["COK"]);
  });

  it("spawns the kit for a dormant faction too", async () => {
    // ⚠️ dormant is the third HOLDING status and the only one no other test
    // covers. Drop it from the inArray filter and every dormant faction's kit
    // silently stops spawning — which is the whole projection design, since
    // "disband and lapse fall out for free" only holds if the code filters by
    // exactly the holding set.
    await seedFaction({ tag: "DOR", texture: "Flag_Wolf", x: "100.50", y: "20.25", z: "300.75", status: "dormant" });
    const bodies: string[] = [];
    const client = { uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    const r = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(r).toEqual({ factions: 1, uploaded: true });
    const objects = JSON.parse(bodies[0]!).Objects;
    expect(objects).toHaveLength(103);
    expect(objects.every((o: any) => o.customString === "DOR")).toBe(true);
    expect(objects.some((o: any) => o.name === "Flag_Wolf")).toBe(true);
  });

  it("emits factions in a stable tag order regardless of insertion order", async () => {
    // ⚠️ Determinism. The bytes are hashed; if the row order can vary between
    // ticks the hash varies with it and every sweep re-uploads forever.
    await seedFaction({ tag: "ZZZ", texture: "Flag_Wolf", x: "1", y: "2", z: "3", status: "active" });
    await seedFaction({ tag: "AAA", texture: "Flag_Rooster", x: "4", y: "5", z: "6", status: "active" });
    const bodies: string[] = [];
    const client = { uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    const tags = JSON.parse(bodies[0]!).Objects.map((o: any) => o.customString);
    expect(tags[0]).toBe("AAA");
    expect(tags[tags.length - 1]).toBe("ZZZ");
  });
});
