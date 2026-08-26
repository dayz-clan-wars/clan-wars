import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, servers, admFiles, events, poles, flagChanges, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import type { EventType } from "@factions/domain";
import { runProjector } from "../src/run.js";

const URL = process.env.TEST_DATABASE_URL;
const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";
const POLE = { x: 2991.569092, y: 447.946503, z: 1138.587646 };
const KEY = "2991.57:447.95:1138.59";

describe.skipIf(!URL)("projector", () => {
  let db: Database;
  let serverId: number;
  let admFileId: number;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL!);
    await runMigrations(db);
    await db.execute(sql`truncate table flag_changes, poles, events, raw_lines, adm_files, servers, consumer_cursors restart identity cascade`);
    const [srv] = await db.insert(servers).values({ name: "T", map: "livonia" }).returning();
    serverId = srv!.id;
    const [f] = await db.insert(admFiles).values({
      serverId, filename: "a.ADM", bootAt: new Date("2026-07-22T00:00:00Z"),
    }).returning();
    admFileId = f!.id;
    line = 0;
  });

  const emit = async (type: EventType, payload: unknown, at: string) => {
    await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type, occurredAt: new Date(at), payload: payload as object,
    });
  };

  const raise = (texture: string, at: string) =>
    emit("flag.raised", { gamertag: "A", dayzId: ID, texture, action: "raised", pole: POLE, poleKey: KEY, player: null }, at);

  it("creates a pole on the first raise", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await runProjector(db);
    const rows = await db.select().from(poles);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.poleKey).toBe(KEY);
    expect(rows[0]?.flagRaised).toBe(true);
    expect(rows[0]?.currentTexture).toBe("Flag_Livonia");
  });

  it("does not duplicate the pole across many events", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await raise("Flag_Livonia", "2026-07-29T10:00:00Z");
    await runProjector(db);
    expect(await db.select().from(poles)).toHaveLength(1);
  });

  it("records each raise and lower in flag_changes", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await emit("flag.lowered", { gamertag: "B", dayzId: ID, texture: "Flag_Livonia", action: "lowered", pole: POLE, poleKey: KEY, player: null }, "2026-07-22T11:00:00Z");
    await runProjector(db);
    expect(await db.select().from(flagChanges)).toHaveLength(2);
  });

  it("clears flagRaised on a lower", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await emit("flag.lowered", { gamertag: "B", dayzId: ID, texture: "Flag_Livonia", action: "lowered", pole: POLE, poleKey: KEY, player: null }, "2026-07-22T11:00:00Z");
    await runProjector(db);
    const [p] = await db.select().from(poles);
    expect(p?.flagRaised).toBe(false);
  });

  it("tracks a texture change on the same pole", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await raise("Flag_Bohemia", "2026-07-23T10:00:00Z");
    await runProjector(db);
    const [p] = await db.select().from(poles);
    expect(p?.currentTexture).toBe("Flag_Bohemia");
  });

  it("binds a fold to the nearest pole within 10m", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await emit("flagpole.folded", {
      gamertag: "C", dayzId: ID, action: "folded", part: null, tool: null,
      player: { x: 2993.0, y: 448.0, z: 1139.0 },
    }, "2026-07-24T10:00:00Z");
    await runProjector(db);
    const [p] = await db.select().from(poles);
    expect(p?.foldedAt?.toISOString()).toBe("2026-07-24T10:00:00.000Z");
  });

  it("ignores a fold with no pole within 10m", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await emit("flagpole.folded", {
      gamertag: "C", dayzId: ID, action: "folded", part: null, tool: null,
      player: { x: 9000.0, y: 100.0, z: 9000.0 },
    }, "2026-07-24T10:00:00Z");
    await runProjector(db);
    const [p] = await db.select().from(poles);
    expect(p?.foldedAt).toBeNull();
  });

  it("advances the cursor so a second run is a no-op", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    expect(await runProjector(db)).toBe(1);
    expect(await runProjector(db)).toBe(0);
    expect(await db.select().from(flagChanges)).toHaveLength(1);
  });
});
