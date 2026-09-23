import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, rawLines, events, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { backfillHubPositions } from "../src/hub-backfill.js";

const URL = requireTestDatabaseUrl();
const V = "A".repeat(40), K = "B".repeat(40);
const HIT = `17:24:38 | Player "Vic" (id=${V} pos=<101.0, 95.0, 998.6>)[HP: 71.6] hit by Player "Kil" (id=${K} pos=<99.3, 93.2, 998.6>) into Torso(21) for 28.3 damage (Bullet_556x45) with M4-A1 from 2.6 meters`;
const KILL = `17:25:00 | Player "Vic" (DEAD) (id=${V} pos=<101.0, 95.0, 998.6>) killed by Player "Kil" (id=${K} pos=<99.0, 93.0, 998.6>) with M4-A1 from 2.1 meters`;

describe("backfillHubPositions", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate events, raw_lines, adm_files, servers restart identity cascade`);
    serverId = (await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning())[0]!.id;
    fileId = (await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: new Date(), linesIngested: 0, complete: true }).returning())[0]!.id;
    line = 0;
  });
  const ingested = async (type: string, content: string, payload: Record<string, unknown>) => {
    const [r] = await db.insert(rawLines).values({ admFileId: fileId, lineIndex: line, content }).returning();
    await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: type as never, occurredAt: new Date(), payload, rawLineId: r!.id });
  };
  const payloads = async () => (await db.select().from(events).orderBy(events.id)).map((e) => e.payload as Record<string, unknown>);

  it("adds positions re-parsed from the stored raw line, keeping every existing key", async () => {
    await ingested("player.hit", HIT, { victimDayzId: V, attackerDayzId: K, damage: 28.3 });
    await ingested("player.killed", KILL, { victimDayzId: V, killerDayzId: K });
    const r = await backfillHubPositions(db, { serverId, apply: true });
    expect(r).toEqual({ scanned: 2, updated: 2, unparsed: 0 });
    const [hit, kill] = await payloads();
    expect(hit).toMatchObject({ damage: 28.3, victimPos: { x: 101, y: 998.6, z: 95 }, attackerPos: { x: 99.3, y: 998.6, z: 93.2 } });
    expect(kill).toMatchObject({ victimPos: { x: 101, y: 998.6, z: 95 }, killerPos: { x: 99, y: 998.6, z: 93 } });
    expect("pos" in hit! || "pos" in kill!).toBe(false);
  });

  it("is idempotent and skips events that already carry positions", async () => {
    await ingested("player.hit", HIT, { victimDayzId: V });
    await backfillHubPositions(db, { serverId, apply: true });
    expect(await backfillHubPositions(db, { serverId, apply: true })).toEqual({ scanned: 0, updated: 0, unparsed: 0 });
  });

  it("a dry run counts and writes nothing", async () => {
    await ingested("player.hit", HIT, { victimDayzId: V });
    expect((await backfillHubPositions(db, { serverId, apply: false })).updated).toBe(1);
    expect("victimPos" in (await payloads())[0]!).toBe(false);
  });

  it("⚠️ a reparsed event (raw_line_id null, raw line present) is found by file + line, not skipped", async () => {
    // A reparse inserts events whose raw line already exists, so the worker's
    // onConflictDoNothing().returning() hands back nothing and raw_line_id is null —
    // 22 of 308 kill events in factions_live on 2026-09-22.
    await db.insert(rawLines).values({ admFileId: fileId, lineIndex: line, content: KILL });
    await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.killed", occurredAt: new Date(), payload: { victimDayzId: V } });
    expect(await backfillHubPositions(db, { serverId, apply: true })).toEqual({ scanned: 1, updated: 1, unparsed: 0 });
    expect((await payloads())[0]).toMatchObject({ killerPos: { x: 99, y: 998.6, z: 93 } });
  });

  it("an event without a raw line is counted as unparsed, not guessed", async () => {
    await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.hit", occurredAt: new Date(), payload: { victimDayzId: V } });
    expect(await backfillHubPositions(db, { serverId, apply: true })).toEqual({ scanned: 1, updated: 0, unparsed: 1 });
  });
});
