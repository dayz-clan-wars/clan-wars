import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, declarations, factionMembers, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { clearBasesBefore } from "../src/clear-bases.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const cutoff = new Date("2026-10-08T00:00:00Z");
const before = new Date("2026-09-14T00:00:00Z");
const after = new Date("2026-10-10T00:00:00Z");
const at = new Date("2026-10-12T20:00:00Z");

describe("clearBasesBefore", () => {
  let db: Database;
  let serverId = 0;
  let OLD = 0;
  let NEW = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table declarations, poles, faction_members, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "chernarusplus", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    OLD = (await seedFaction(db, { serverId, tag: "OLD", texture: "Flag_Old", poleKey: "2000.00:100.00:2000.00", x: 2000, y: 100, z: 2000, createdAt: before, activatedAt: before, status: "dormant", dormantSince: before })).id;
    await db.update(factions).set({ flagDownSince: before, flagDownByDayzId: "X", disbandWarnedAt: before }).where(eq(factions.id, OLD));
    await db.insert(factionMembers).values({ factionId: OLD, serverId, dayzId: "M", discordId: "dM", role: "leader", joinedAt: before, status: "full" });
    NEW = (await seedFaction(db, { serverId, tag: "NEW", texture: "Flag_New", poleKey: "8000.00:100.00:8000.00", x: 8000, y: 100, z: 8000, createdAt: after, activatedAt: after })).id;
  });

  it("releases only bases declared before the cutoff and clears their clans' flag-down state", async () => {
    const r = await clearBasesBefore(db, serverId, cutoff, { at, dryRun: false });
    expect(r).toEqual({ dryRun: false, clansCleared: 1, released: [{ owner: "OLD", declaredAt: before, x: 2000, z: 2000 }] });
    const left = await db.select({ f: declarations.ownerFactionId }).from(declarations);
    expect(left).toEqual([{ f: NEW }]);
    const [old] = await db.select().from(factions).where(eq(factions.id, OLD));
    expect(old).toMatchObject({ status: "dormant", flagDownSince: null, flagDownByDayzId: null, disbandWarnedAt: null });
    expect(await db.select().from(factionMembers)).toHaveLength(1); // roster untouched
  });

  it("⚠️ a dry run reports the same rows and writes nothing", async () => {
    const r = await clearBasesBefore(db, serverId, cutoff, { at, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, released: [{ owner: "OLD" }] });
    expect(await db.select().from(declarations)).toHaveLength(2);
    const [old] = await db.select({ f: factions.flagDownSince }).from(factions).where(eq(factions.id, OLD));
    expect(old!.f).toEqual(before);
  });

  it("is a no-op the second time", async () => {
    await clearBasesBefore(db, serverId, cutoff, { at, dryRun: false });
    expect(await clearBasesBefore(db, serverId, cutoff, { at, dryRun: false })).toEqual({ dryRun: false, released: [], clansCleared: 0 });
  });
});
