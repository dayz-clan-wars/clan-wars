import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, supplyUploads, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { seedFaction as seedFactionAndDeclaration } from "./seed.js";
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
  }) => seedFactionAndDeclaration(db, {
    serverId: opts.serverId ?? serverId,
    tag: opts.tag, texture: opts.texture, status: opts.status,
    // The coordinates the kit spawns at now live on the declaration, so they
    // travel through the helper rather than onto the faction row.
    poleKey: `${opts.x}:${opts.y}:${opts.z}`,
    x: Number(opts.x), y: Number(opts.y), z: Number(opts.z),
    createdAt: now,
    // The factions_reserved_has_deadline check rejects a reserved row
    // without one.
    reservedUntil: opts.status === "reserved" ? new Date("2026-09-08T12:00:00Z") : null,
  });

  beforeEach(async () => {
    db = createClient(DB_URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table supply_uploads, declarations, poles, events, adm_files, factions, servers restart identity cascade`);
    });
    serverId = await seedServer("S");
  });

  it("uploads the kit for a holding faction", async () => {
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "active" });
    const uploads: { dir: string; name: string; body: string }[] = [];
    const client = { statFile: async () => null, uploadFile: async (dir: string, name: string, body: string) => { uploads.push({ dir, name, body }); } };

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
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "active" });
    let calls = 0;
    const client = { statFile: async () => null, uploadFile: async () => { calls++; } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    const second = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(calls).toBe(1);
    expect(second.uploaded).toBe(false);
    expect(second.factions).toBe(1);
  });

  it("uploads again when a faction's texture changes", async () => {
    const f = await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "active" });
    let calls = 0;
    const client = { statFile: async () => null, uploadFile: async () => { calls++; } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    await db.update(factions).set({ texture: "Flag_Wolf" }).where(eq(factions.id, f.id));
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(calls).toBe(2);
  });

  it("drops a faction that stopped holding", async () => {
    const f = await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "active" });
    const bodies: string[] = [];
    const client = { statFile: async () => null, uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
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
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "active" });
    let calls = 0;
    const failing = { statFile: async () => null, uploadFile: async () => { calls++; throw new Error("nitrado down"); } };
    await expect(supplyTick(db, { serverId, client: failing, offsets, remoteDir: "/d", fileName: "f.json", now })).rejects.toThrow(/nitrado down/);
    expect(await db.select().from(supplyUploads)).toHaveLength(0);

    const ok = { statFile: async () => null, uploadFile: async () => { calls++; } };
    const retry = await supplyTick(db, { serverId, client: ok, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(retry.uploaded).toBe(true);
    expect(calls).toBe(2);
  });

  it("⚠️ omits a supplied clan that holds no declaration", async () => {
    // The kit spawns at the clan's DECLARED pole. A supplied clan with none —
    // after a wipe, or between a release and a re-claim — has nowhere for one
    // to land, so it drops out of the file rather than having a place
    // invented for it. The join is INNER for exactly this; a LEFT one would
    // put every such clan's crate at (0, 0, 0).
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "active" });
    await db.insert(factions).values({
      serverId, name: "Homeless", tag: "HML", texture: "Flag_Wolf",
      status: "active", leaderDiscordId: "d2", createdAt: now,
    });

    const bodies: string[] = [];
    const client = { statFile: async () => null, uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    const r = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });

    expect(r.factions).toBe(1);
    expect(bodies[0]).not.toContain("Flag_Wolf");
  });

  it("reads numeric coordinates as numbers, not strings", async () => {
    // ⚠️ declarations.x/y/z are Postgres numeric, which Drizzle returns as
    // STRINGS. "5551.69" + 0.898 is "5551.690.898". Without Number() every
    // coordinate in the file is corrupt.
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "active" });
    const bodies: string[] = [];
    const client = { statFile: async () => null, uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
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
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "active" });
    await seedFaction({ tag: "OTH", texture: "Flag_Wolf", x: "1", y: "2", z: "3", status: "active", serverId: other });
    const bodies: string[] = [];
    const client = { statFile: async () => null, uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    const objects = JSON.parse(bodies[0]!).Objects;
    expect(objects).toHaveLength(103);
    expect([...new Set(objects.map((o: any) => o.customString))]).toEqual(["COK"]);
  });

  it("does not spawn supplies for a dormant faction", async () => {
    // ⚠️ dormant is a HOLDING status but not a SUPPLIED status. The identity
    // projection (indexes) includes it to preserve the flag; the supply
    // projection excludes it. A stale flag yields an empty file and no supply kit.
    await seedFaction({ tag: "DOR", texture: "Flag_Wolf", x: "100.50", y: "20.25", z: "300.75", status: "dormant" });
    const bodies: string[] = [];
    const client = { statFile: async () => null, uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    const r = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(r).toEqual({ factions: 0, uploaded: true });
    const objects = JSON.parse(bodies[0]!).Objects;
    expect(objects).toEqual([]);
  });

  it("⚠️ omits a reserved faction — SUPPLIED_PREDICATE narrows the old status list", async () => {
    // Under the old SUPPLIED_STATUSES a reserved clan was supplied; under the
    // new predicate ("status = 'active' and flag_down_since is null") it is
    // not. This pins that narrowing so it cannot silently widen back.
    await seedFaction({ tag: "RSV", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    const bodies: string[] = [];
    const client = { statFile: async () => null, uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    const r = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(r).toEqual({ factions: 0, uploaded: true });
    expect(JSON.parse(bodies[0]!)).toEqual({ Objects: [] });
  });

  it("⚠️ omits an active clan whose flag is down", async () => {
    // Supplied is a predicate, not a status list: "status = 'active' and
    // flag_down_since is null" (spec §4.3). A raided clan keeps `active` for
    // its 24h clock but loses its kit the instant flag_down_since is set.
    const f = await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "active" });
    await db.update(factions).set({ flagDownSince: now }).where(eq(factions.id, f.id));
    const bodies: string[] = [];
    const client = { statFile: async () => null, uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    const r = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(r).toEqual({ factions: 0, uploaded: true });
    const objects = JSON.parse(bodies[0]!).Objects;
    expect(objects).toEqual([]);
  });

  it("emits factions in a stable tag order regardless of insertion order", async () => {
    // ⚠️ Determinism. The bytes are hashed; if the row order can vary between
    // ticks the hash varies with it and every sweep re-uploads forever.
    await seedFaction({ tag: "ZZZ", texture: "Flag_Wolf", x: "1", y: "2", z: "3", status: "active" });
    await seedFaction({ tag: "AAA", texture: "Flag_Rooster", x: "4", y: "5", z: "6", status: "active" });
    const bodies: string[] = [];
    const client = { statFile: async () => null, uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    const tags = JSON.parse(bodies[0]!).Objects.map((o: any) => o.customString);
    expect(tags[0]).toBe("AAA");
    expect(tags[tags.length - 1]).toBe("ZZZ");
  });

  it("⚠️ omits a dormant faction — this is how a stale flag stops the kit", async () => {
    // The bot sets the status; the worker only reads it. Nothing coordinates
    // the two, which is why this filter is the whole mechanism.
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "1", y: "2", z: "3", status: "active" });
    await seedFaction({ tag: "DRM", texture: "Flag_Wolf", x: "4", y: "5", z: "6", status: "dormant" });
    const bodies: string[] = [];
    const client = { statFile: async () => null, uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };

    const r = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(r.factions).toBe(1);
    const tags = new Set(JSON.parse(bodies[0]!).Objects.map((o: any) => o.customString));
    expect([...tags]).toEqual(["COK"]);
  });

  it("changes the hash when a faction goes dormant, so the file is re-uploaded", async () => {
    // Without a hash change the tick short-circuits and the dormant faction's
    // kit keeps respawning at every restart forever.
    const f = await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "1", y: "2", z: "3", status: "active" });
    const bodies: string[] = [];
    const client = { statFile: async () => null, uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    await db.update(factions).set({ status: "dormant" }).where(eq(factions.id, f.id));
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1]!)).toEqual({ Objects: [] });
  });
});
