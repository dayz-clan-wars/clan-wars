import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, factionEvents, factions, factionMembers, servers, type Database } from "@factions/db";
import { asc, eq, sql } from "drizzle-orm";
import { PgDormancyStore } from "../src/dormancy-store.js";
import { PgRosterStore } from "../src/roster-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");
const disbandAt = new Date("2026-09-17T12:00:00Z");

describe("dormancy path writes feed events", () => {
  let db: Database;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_events, faction_invites, faction_members, factions, servers restart identity cascade`);
    });

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    const [f] = await db.insert(factions).values({
      serverId: s!.id, name: "Bears", tag: "BEAR", texture: "Flag_Bear", poleKey: "1:2:3",
      x: "1", y: "2", z: "3", status: "active", leaderDiscordId: "d1", createdAt: now,
    }).returning();
    factionId = f!.id;

    await db.insert(factionMembers).values({
      factionId, serverId: s!.id, discordId: "d1", dayzId: "A".repeat(40), role: "leader", joinedAt: now,
    });
  });

  const events = () => db.select().from(factionEvents).orderBy(asc(factionEvents.id));

  it("writes dormant with the disband deadline, and no actor", async () => {
    expect(await new PgDormancyStore(db).goDormant(factionId, now, disbandAt)).toBe(true);
    const [e] = await events();
    expect(e!.kind).toBe("dormant");
    expect(e!.payload).toMatchObject({ name: "Bears", tag: "BEAR", disbandAt: disbandAt.toISOString() });
    expect((e!.payload as Record<string, unknown>).actor).toBeUndefined();
  });

  it("⚠️ writes nothing when the guarded update matches no row", async () => {
    // Every dormancy transition is guarded on the status it expects and
    // reports whether it moved a row; that boolean is what makes the DM
    // at-most-once. The feed row must obey the same guard.
    const store = new PgDormancyStore(db);
    await store.goDormant(factionId, now, disbandAt);
    expect(await store.goDormant(factionId, now, disbandAt)).toBe(false);
    expect(await events()).toHaveLength(1);
  });

  it("writes revived with no actor", async () => {
    const store = new PgDormancyStore(db);
    await store.goDormant(factionId, now, disbandAt);
    expect(await store.revive(factionId)).toBe(true);
    const rows = await events();
    expect(rows.at(-1)!.kind).toBe("revived");
    expect((rows.at(-1)!.payload as Record<string, unknown>).actor).toBeUndefined();
  });

  it("⚠️ writes disbanded once, from the shared transaction both paths use", async () => {
    // disbandFactionTx is shared by /faction disband and the dormancy tick's
    // auto-disband. Logging in the shared function is what stops one path
    // announcing and the other going silent.
    await new PgRosterStore(db).disband(factionId, "d1");
    const rows = await events();
    expect(rows.at(-1)!.kind).toBe("disbanded");
    expect(rows.at(-1)!.payload).toMatchObject({ name: "Bears", tag: "BEAR", texture: "Flag_Bear" });
  });

  it("⚠️ freezes identity on the disbanded row, which the factions row has released", async () => {
    // By the time the post goes out the flag, tag and pole are back in the
    // pool and may already belong to somebody else.
    await new PgRosterStore(db).disband(factionId, "d1");
    await db.update(factions).set({ name: "Someone Else" }).where(eq(factions.id, factionId));
    const rows = await events();
    expect((rows.at(-1)!.payload as Record<string, unknown>).name).toBe("Bears");
  });

  it("writes no disbanded row when the leader guard rejects", async () => {
    expect(await new PgRosterStore(db).disband(factionId, "not-the-leader")).toBe("not-leader");
    expect(await events()).toHaveLength(0);
  });
});
