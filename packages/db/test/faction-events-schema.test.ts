import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionEvents, type Database,
} from "@factions/db";
import { FACTION_EVENT_KINDS, type FactionEventKind } from "@factions/domain";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");

describe("faction_events", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_events, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
      poleKey: "1:2:3", x: "1", y: "2", z: "3", status: "active",
      leaderDiscordId: "d1", createdAt: now,
    }).returning();
    factionId = f!.id;
  });

  // ⚠️ `kind` casts to FactionEventKind here, not the column definition — the
  // column stays typed so a real caller can't pass an invalid kind and have
  // TypeScript wave it through. This cast exists only so the deliberately-
  // invalid "exploded" case below still compiles while exercising the SQL
  // constraint instead of the type system.
  const insert = (kind: string, payload: Record<string, unknown>) =>
    db.insert(factionEvents).values({
      serverId, factionId, kind: kind as FactionEventKind, occurredAt: now, payload,
    }).returning();

  it("stores a row with posted_at null by default", async () => {
    const [row] = await insert("founded", { name: "Bears", tag: "BEAR", texture: "Flag_Bear" });
    expect(row!.postedAt).toBeNull();
    expect(row!.occurredAt).toEqual(now);
  });

  it("⚠️ rejects a payload carrying pole coordinates", async () => {
    // The pole invariant is otherwise held only by every author remembering
    // it at every call site. This is the first table whose whole purpose is
    // to be published, so the database refuses rather than the reviewer.
    for (const key of ["poleKey", "x", "y", "z"]) {
      await expect(insert("founded", { name: "Bears", tag: "BEAR", texture: "Flag_Bear", [key]: "1:2:3" }))
        .rejects.toThrow(/faction_events_no_coordinates/u);
    }
  });

  it("rejects an unknown kind", async () => {
    await expect(insert("exploded", { name: "Bears", tag: "BEAR", texture: "Flag_Bear" }))
      .rejects.toThrow(/faction_events_kind_valid/u);
  });

  it("⚠️ the SQL kind constraint enumerates exactly FACTION_EVENT_KINDS", async () => {
    // Two statements of one fact: the TypeScript union and a SQL check
    // constraint. Drift means a writer inserts a kind the database rejects
    // at the worst possible moment — inside a transition's own transaction,
    // rolling the transition back.
    const rows = await db.execute(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'faction_events_kind_valid'
    `);
    const def = (rows as unknown as { def: string }[])[0]!.def;
    const inSql = [...def.matchAll(/'([a-z]+)'::text/gu)].map((m) => m[1]);
    expect(new Set(inSql)).toEqual(new Set(FACTION_EVENT_KINDS));
  });

  it("accepts every kind in FACTION_EVENT_KINDS", async () => {
    for (const kind of FACTION_EVENT_KINDS) {
      const [row] = await insert(kind, { name: "Bears", tag: "BEAR", texture: "Flag_Bear" });
      expect(row!.kind).toBe(kind);
    }
  });
});
