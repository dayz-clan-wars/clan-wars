import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, clanNotices, flagHolds, factions, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { FLAG_CHANGE_WINDOW_MS } from "@factions/domain";
import { adminFlagChange } from "../src/admin-flag-change.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-10-16T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const DAY = 86_400_000;

describe("adminFlagChange", () => {
  let db: Database;
  let serverId = 0;
  let VOLK = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table flag_holds, faction_textures, clan_notices, faction_events, faction_members, declarations, poles, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "chernarusplus", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    // Renamed four days ago: the leader's own rebrand is inside its cooldown.
    VOLK = (await seedFaction(db, { serverId, tag: "VOLK", texture: "Flag_Rooster", createdAt: ago(10 * DAY), activatedAt: ago(10 * DAY), renamedAt: ago(4 * DAY) })).id;
  });

  const holds = () => db.select().from(flagHolds);
  const notices = () => db.select({ kind: clanNotices.kind, target: clanNotices.target }).from(clanNotices);

  it("starts the ordinary flag change despite the cooldown, without restarting it", async () => {
    const r = await adminFlagChange(db, { serverId, tag: "VOLK", texture: "Flag_Wolf", at: now, apply: true });
    expect(r).toEqual({ outcome: "flag-pending", until: new Date(now.getTime() + FLAG_CHANGE_WINDOW_MS) });
    const [h] = await holds();
    expect(h).toMatchObject({ factionId: VOLK, texture: "Flag_Wolf", kind: "pending", stampsCooldown: false });
    expect(await notices()).toEqual([{ kind: "flag_change_started", target: "channel" }]);
    // The clan still flies its old flag until a member raises the new one.
    const [f] = await db.select({ texture: factions.texture, renamedAt: factions.renamedAt }).from(factions).where(eq(factions.id, VOLK));
    expect(f).toEqual({ texture: "Flag_Rooster", renamedAt: ago(4 * DAY) });
  });

  it("a dry run refuses what the real run would and writes nothing", async () => {
    expect((await adminFlagChange(db, { serverId, tag: "VOLK", texture: "Flag_Wolf", at: now, apply: false })).outcome).toBe("dry-run");
    expect(await holds()).toEqual([]);
    expect(await notices()).toEqual([]);
  });

  it("keeps the flag rules: a flag another clan flies or holds is refused", async () => {
    await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000, createdAt: ago(DAY) });
    expect((await adminFlagChange(db, { serverId, tag: "VOLK", texture: "Flag_Wolf", at: now, apply: true })).outcome).toBe("flag-taken");
    expect(await holds()).toEqual([]);
  });

  it("refuses a second change, an unknown flag, the same flag and a missing clan", async () => {
    await adminFlagChange(db, { serverId, tag: "VOLK", texture: "Flag_Wolf", at: now, apply: true });
    expect((await adminFlagChange(db, { serverId, tag: "VOLK", texture: "Flag_Bear", at: now, apply: true })).outcome).toBe("change-pending");
    expect((await adminFlagChange(db, { serverId, tag: "VOLK", texture: "Flag_Nope", at: now, apply: true })).outcome).toBe("unknown-flag");
    expect((await adminFlagChange(db, { serverId, tag: "VOLK", texture: "Flag_Rooster", at: now, apply: true })).outcome).toBe("unchanged");
    expect((await adminFlagChange(db, { serverId, tag: "NONE", texture: "Flag_Bear", at: now, apply: true })).outcome).toBe("no-clan");
  });
});
