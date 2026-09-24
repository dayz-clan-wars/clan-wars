import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, kothEvents, awardGrants, servers, type Database } from "../src/index.js";

const URL = requireTestDatabaseUrl();
const SLOT = new Date("2026-10-03T20:00:00Z");

describe("koth_events", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table koth_events, award_grants, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });
  const row = (over: Record<string, unknown> = {}) => ({
    serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
    state: "scheduled" as const, scheduledByDiscordId: "1", ...over,
  });

  // ⚠️ Spec §2.12: one event at a time — the index is the guard, not the command.
  it("allows only one scheduled-or-live event per server", async () => {
    await db.insert(kothEvents).values(row());
    await expect(db.insert(kothEvents).values(row({ slotAt: new Date("2026-10-04T20:00:00Z") })))
      .rejects.toThrow(/koth_events_one_open/u);
    await db.insert(kothEvents).values(row({ slotAt: new Date("2026-10-05T20:00:00Z"), state: "cancelled" }));
  });
  // ⚠️ Migration 0050: a cancelled or failed row must not hold its slot, or that
  // slot can never be scheduled again; a live or finished one still does.
  it("frees a slot held only by a cancelled or failed row, and no other", async () => {
    await db.insert(kothEvents).values(row({ state: "cancelled" }));
    await db.insert(kothEvents).values(row({ state: "failed" }));
    await db.insert(kothEvents).values(row());
    await expect(db.insert(kothEvents).values(row({ state: "no_winner" }))).rejects.toThrow(/koth_events_slot_uq/u);
  });
  // ⚠️ Migration 0051: a prize-less session that ran still holds its slot.
  it("a finished row holds its slot", async () => {
    await db.insert(kothEvents).values(row({ state: "finished" }));
    await expect(db.insert(kothEvents).values(row({ state: "scheduled" }))).rejects.toThrow(/koth_events_slot_uq/u);
  });
  it("refuses an unknown state", async () => {
    await expect(db.insert(kothEvents).values(row({ state: "late" as never }))).rejects.toThrow(/koth_events_state_valid/u);
  });
  it("ties award_grant_id to the awarded state", async () => {
    await expect(db.insert(kothEvents).values(row({ state: "awarded" }))).rejects.toThrow(/koth_events_awarded_has_grant/u);
  });
  // ⚠️ Migration 0051: `awarded` means a prize was granted, so it needs one.
  it("refuses an awarded row with no prize, and allows a finished one", async () => {
    const [g] = await db.insert(awardGrants).values({
      awardKey: "plate-carrier", discordId: "5", grantedByDiscordId: "1", reason: "t", grantedAt: SLOT, placeBy: SLOT,
    }).returning();
    await expect(db.insert(kothEvents).values(row({ state: "awarded", awardGrantId: g!.id, awardKey: null })))
      .rejects.toThrow(/koth_events_awarded_has_prize/u);
    await db.insert(kothEvents).values(row({ state: "awarded", awardGrantId: g!.id, awardKey: "plate-carrier" }));
    await db.insert(kothEvents).values(row({ slotAt: new Date("2026-10-04T20:00:00Z"), state: "finished", awardKey: null }));
  });
});
