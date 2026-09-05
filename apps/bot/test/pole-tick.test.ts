import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, poles, events, admFiles, type Database } from "@factions/db";
import { NEW_POLE_GRACE_MS } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { runPoleProjection } from "../src/pole-tick.js";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-09-04T12:00:00Z");

describe("runPoleProjection", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table poles, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    lineIndex = 0;
  });

  const flag = (action: "raised" | "lowered", at: Date, texture = "Flag_White") =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: `flag.${action}`, occurredAt: at,
      payload: { dayzId: "A", gamertag: "G", texture, action, poleKey: "10.00:20.00:30.00", pole: { x: 10, y: 20, z: 30 } },
    });

  it("creates a pole on first sight with grace_until = first sighting + 7 days", async () => {
    await flag("raised", t0);
    const r = await runPoleProjection(db);
    expect(r).toEqual({ scanned: 1, upserted: 1 });
    const [p] = await db.select().from(poles).where(eq(poles.serverId, serverId));
    expect(p!.flagRaised).toBe(true);
    expect(p!.currentTexture).toBe("Flag_White");
    expect(p!.graceUntil.getTime()).toBe(t0.getTime() + NEW_POLE_GRACE_MS);
  });

  it("⚠️ a later event does not move grace_until", async () => {
    await flag("raised", t0);
    await runPoleProjection(db);
    await flag("lowered", new Date(t0.getTime() + 3_600_000));
    await runPoleProjection(db);
    const [p] = await db.select().from(poles).where(eq(poles.serverId, serverId));
    expect(p!.flagRaised).toBe(false);
    expect(p!.graceUntil.getTime()).toBe(t0.getTime() + NEW_POLE_GRACE_MS);
  });

  it("is idempotent across runs — the cursor advances", async () => {
    await flag("raised", t0);
    await runPoleProjection(db);
    expect(await runPoleProjection(db)).toEqual({ scanned: 0, upserted: 0 });
  });
});
