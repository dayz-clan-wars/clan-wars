import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, declarations, events, admFiles, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { adoptCarriedTx, declarationForFaction } from "../src/store";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-10-20T12:00:00Z");
const key = (x: number, z: number) => `${x.toFixed(2)}:100.00:${z.toFixed(2)}`;

describe("adoptCarriedTx", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;
  let BEAR = 0;
  let WOLF = 0;

  const event = async () => {
    const [e] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: now, payload: {},
    }).returning();
    return e!.id;
  };
  const clan = async (tag: string) => {
    const [f] = await db.insert(factions).values({
      serverId, name: tag, tag, texture: `Flag_${tag}`, status: "active", leaderDiscordId: "d", createdAt: now,
    }).returning();
    return f!.id;
  };
  const declare = async (factionId: number, x: number, z: number, carried: boolean) => {
    await db.insert(declarations).values({
      serverId, poleKey: key(x, z), x: x.toFixed(2), y: "100.00", z: z.toFixed(2),
      ownerFactionId: factionId, evidenceEventId: await event(), declaredAt: now,
      carriedSince: carried ? now : null,
    });
  };
  const adopt = async (factionId: number, x: number, z: number) => {
    const eventId = await event();
    return db.transaction((tx) => adoptCarriedTx(tx, {
      serverId, factionId, poleKey: key(x, z), x, y: 100, z, eventId, at: now,
    }));
  };

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table declarations, factions, events, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "chernarusplus", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    line = 0;
    BEAR = await clan("BEAR");
    WOLF = await clan("WOLF");
  });

  it("re-points a carried declaration to the new pole and clears carried_since", async () => {
    await declare(BEAR, 5000, 5000, true);
    expect(await adopt(BEAR, 5040, 5030)).toEqual({ ok: true });
    const d = await declarationForFaction(db, BEAR);
    expect(d).toMatchObject({ poleKey: key(5040, 5030), x: "5040.00", z: "5030.00", carriedSince: null, declaredAt: now });
    const [row] = await db.select().from(declarations).where(eq(declarations.ownerFactionId, BEAR));
    expect(row!.evidenceEventId).not.toBeNull();
    expect(row!.evidenceCeremonyId).toBeNull();
    expect(await db.select().from(declarations)).toHaveLength(1);
  });

  it("refuses a declaration that is not carried", async () => {
    await declare(BEAR, 5000, 5000, false);
    expect(await adopt(BEAR, 5040, 5030)).toEqual({ ok: false, reason: "not-carried" });
    expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: key(5000, 5000) });
  });

  it("refuses a clan with no declaration as not-carried", async () => {
    expect(await adopt(BEAR, 5040, 5030)).toEqual({ ok: false, reason: "not-carried" });
  });

  it("refuses a pole within 200 m of another base, ignoring the clan's own", async () => {
    await declare(BEAR, 5000, 5000, true);
    await declare(WOLF, 5250, 5000, true);
    expect(await adopt(BEAR, 5080, 5000)).toEqual({ ok: false, reason: "too-close" });
    expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: key(5000, 5000), carriedSince: now });
  });

  it("refuses a pole another base already sits on", async () => {
    await declare(BEAR, 5000, 5000, true);
    await declare(WOLF, 9000, 9000, false);
    // Spacing would also catch this; the pole-taken check must win so the
    // reason names the real problem.
    expect(await adopt(BEAR, 9000, 9000)).toEqual({ ok: false, reason: "pole-taken" });
  });
});
