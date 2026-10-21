import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, events, rawLines, admFiles, type Database } from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { repayloadEvents } from "../src/repayload.js";

const URL = requireTestDatabaseUrl();
const V = "89B90470B5F5E8C64EF8B28C89250D6AD1CE2A71";
const TYPES = ["player.hit", "player.died", "base.built"] as const;

const LINES = [
  "AdminLog started on 2026-09-06 at 20:09:46",
  `19:35:14 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 71.59] hit by German Shepherd into Head(0) for 10 damage (MeleeWolf)`,
  `01:06:20 | Player "Vic" (DEAD) (id=${V} pos=<10113.2, 11865.4, 208.6>) killed by NO DRIVER (Motorbike_02_Yellow)`,
  `21:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)Built rubble_rubble1 on  with Hammer`,
  `21:00:01 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)Built wall_base_down on Fence with Hammer`,
];

describe("repayloadEvents", () => {
  let db: Database;
  let serverId: number;
  let fileId: number;
  const ids: Record<string, number> = {};

  const payloadOf = async (id: number) => (await db.select().from(events).where(eq(events.id, id)))[0]!.payload as Record<string, unknown>;
  const allIds = async () => (await db.select({ id: events.id }).from(events).orderBy(events.id)).map((r) => r.id);

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table flag_changes, poles, events, raw_lines, adm_files, servers, consumer_cursors restart identity cascade`);
    const [srv] = await db.insert(servers).values({ name: "T", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = srv!.id;
    const [file] = await db.insert(admFiles).values({ serverId, filename: "a.ADM", bootAt: new Date("2026-09-06T20:09:46Z"), linesIngested: LINES.length, complete: true }).returning();
    fileId = file!.id;
    await db.insert(rawLines).values(LINES.map((content, lineIndex) => ({ admFileId: fileId, lineIndex, content })));
    const ev = async (key: string, lineIndex: number, type: string, payload: unknown) => {
      const [r] = await db.insert(events).values({ serverId, admFileId: fileId, lineIndex, subIndex: 0, type: type as never, occurredAt: new Date("2026-09-06T21:00:00Z"), payload }).returning();
      ids[key] = r!.id;
    };
    // The payloads the OLD parser wrote. raw_line_id is deliberately null: the join is on (adm_file_id, line_index).
    await ev("hit", 1, "player.hit", { victimDayzId: V, attackerType: "environment", attackerLabel: "German", damage: 10, bodyPart: "Head" });
    await ev("death", 2, "player.died", { victimDayzId: V, cause: "environment", entity: "NO" });
    await ev("builtRuin", 3, "base.built", { part: "rubble_rubble1", structure: "with Hammer", tool: null });
    // Already correct: must not be counted as changed.
    await ev("builtOk", 4, "base.built", { tool: "Hammer", pos: { z: 2, y: 3, x: 1 }, part: "wall_base_down", structure: "Fence", action: "built", dayzId: V, gamertag: "Vic" });
  });

  it("dry run counts what would change and writes nothing; apply repairs in place with ids unchanged", async () => {
    const idsBefore = await allIds();
    const dry = await repayloadEvents(db, { types: [...TYPES], apply: false });
    expect(dry).toMatchObject({ scanned: 4, changed: { "player.hit": 1, "player.died": 1, "base.built": 1 }, typeMismatch: 0, noRawLine: 0 });
    expect((await payloadOf(ids.hit!)).attackerLabel).toBe("German");
    expect((await payloadOf(ids.builtRuin!)).structure).toBe("with Hammer");

    const applied = await repayloadEvents(db, { types: [...TYPES], apply: true });
    expect(applied.changed).toEqual({ "player.hit": 1, "player.died": 1, "base.built": 1 });
    expect((await payloadOf(ids.hit!)).attackerLabel).toBe("German Shepherd");
    expect(await payloadOf(ids.death!)).toMatchObject({ cause: "vehicle", entity: "Motorbike_02_Yellow" });
    expect(await payloadOf(ids.builtRuin!)).toMatchObject({ structure: null, tool: "Hammer" });
    expect(await allIds()).toEqual(idsBefore);

    const again = await repayloadEvents(db, { types: [...TYPES], apply: true });
    expect(again.changed).toEqual({});
  });

  it("only touches the requested types", async () => {
    await repayloadEvents(db, { types: ["base.built"], apply: true });
    expect((await payloadOf(ids.hit!)).attackerLabel).toBe("German");
    expect(await payloadOf(ids.builtRuin!)).toMatchObject({ structure: null, tool: "Hammer" });
  });

  it("counts a re-parse that yields a different type or no line, and leaves the row alone", async () => {
    await db.update(events).set({ type: "player.died" }).where(eq(events.id, ids.hit!)); // line 1 now parses to player.hit
    await db.update(events).set({ subIndex: 3 }).where(eq(events.id, ids.builtOk!));      // no such sub-line
    const r = await repayloadEvents(db, { types: [...TYPES], apply: true });
    expect(r.typeMismatch).toBe(2);
    expect((await payloadOf(ids.hit!)).attackerLabel).toBe("German");
  });

  it("counts events with no stored raw line", async () => {
    await db.delete(rawLines).where(eq(rawLines.lineIndex, 2));
    const r = await repayloadEvents(db, { types: [...TYPES], apply: true });
    expect(r.noRawLine).toBe(1);
    expect((await payloadOf(ids.death!)).cause).toBe("environment");
  });
});
