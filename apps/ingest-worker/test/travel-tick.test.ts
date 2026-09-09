import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, travelUploads, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { seedFaction as seedFactionAndDeclaration } from "./seed.js";
import { loadTravelTemplate } from "../src/travel.js";
import { travelTick } from "../src/travel-tick.js";

const DB_URL = requireTestDatabaseUrl();
const template = loadTravelTemplate(JSON.parse(readFileSync(new URL("../assets/teleport-hub.template.json", import.meta.url), "utf8")));
const now = new Date("2026-09-09T12:00:00Z");
const FIXED = template.PRABoxes.length;

describe("travelTick", () => {
  let db: Database;
  let serverId = 0;

  const seed = async (tag: string, status: string, pole = "5551.69:311.63:8790.97") => {
    const [x, y, z] = pole.split(":").map(Number) as [number, number, number];
    return seedFactionAndDeclaration(db, {
      serverId, tag, texture: `Flag_${tag}`, status, poleKey: pole, x, y, z, createdAt: now,
      reservedUntil: status === "reserved" ? new Date("2026-09-16T12:00:00Z") : null,
    });
  };
  const capture = () => {
    const uploads: string[] = [];
    return { uploads, client: { statFile: async () => null, uploadFile: async (_d: string, _n: string, body: string) => { uploads.push(body); } } };
  };
  const boxes = (body: string) => JSON.parse(body).PRABoxes as unknown[][];

  beforeEach(async () => {
    db = createClient(DB_URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table travel_uploads, supply_uploads, declarations, poles, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "enoch", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  it("uploads the template plus one box at an active clan's pole", async () => {
    await seed("COK", "active");
    const { uploads, client } = capture();
    const r = await travelTick(db, { serverId, client, template, remoteDir: "/d", fileName: "t.json", now });
    expect(r).toEqual({ poles: 1, uploaded: true });
    const b = boxes(uploads[0]!);
    expect(b).toHaveLength(FIXED + 1);
    expect(b[FIXED]![2]).toEqual([5551.69, 311.63, 8790.97]);
  });

  it("uploads the bare template when no clan is active, and only once", async () => {
    const { uploads, client } = capture();
    const first = await travelTick(db, { serverId, client, template, remoteDir: "/d", fileName: "t.json", now });
    const second = await travelTick(db, { serverId, client, template, remoteDir: "/d", fileName: "t.json", now });
    expect(first).toEqual({ poles: 0, uploaded: true });
    expect(second).toEqual({ poles: 0, uploaded: false });
    expect(boxes(uploads[0]!)).toHaveLength(FIXED);
  });

  it("⚠️ reserved and dormant clans get no door — only active with the flag up", async () => {
    await seed("RES", "reserved", "6000.00:100.00:6000.00");
    await seed("DOR", "dormant", "7000.00:100.00:7000.00");
    const active = await seed("ACT", "active", "8000.00:100.00:8000.00");
    const { uploads, client } = capture();
    await travelTick(db, { serverId, client, template, remoteDir: "/d", fileName: "t.json", now });
    expect(boxes(uploads[0]!)).toHaveLength(FIXED + 1);
    // The flag goes down: the door closes on the next tick.
    await db.update(factions).set({ flagDownSince: now }).where(eq(factions.id, active.id));
    const r = await travelTick(db, { serverId, client, template, remoteDir: "/d", fileName: "t.json", now });
    expect(r).toEqual({ poles: 0, uploaded: true });
    expect(boxes(uploads[1]!)).toHaveLength(FIXED);
  });

  it("orders poles by tag regardless of insertion order", async () => {
    await seed("ZED", "active", "6000.00:100.00:6000.00");
    await seed("ABE", "active", "7000.00:100.00:7000.00");
    const { uploads, client } = capture();
    await travelTick(db, { serverId, client, template, remoteDir: "/d", fileName: "t.json", now });
    const b = boxes(uploads[0]!);
    expect(b[FIXED]![2]).toEqual([7000, 100, 7000]);
    expect(b[FIXED + 1]![2]).toEqual([6000, 100, 6000]);
  });

  it("does not advance the hash when the upload fails", async () => {
    await seed("COK", "active");
    const client = { statFile: async () => null, uploadFile: async () => { throw new Error("nitrado down"); } };
    await expect(travelTick(db, { serverId, client, template, remoteDir: "/d", fileName: "t.json", now })).rejects.toThrow("nitrado down");
    const rows = await db.select().from(travelUploads).where(eq(travelUploads.serverId, serverId));
    expect(rows).toHaveLength(0);
  });
});
