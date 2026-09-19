import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { attentionDb } from "../src/attention";

const URL = requireTestDatabaseUrl();
const NOW = new Date("2026-09-18T12:00:00Z");
const YOU = "u-attn-you";

/**
 * The bell's count, folded into the same read every page already makes for
 * `you`/`clan`. `notificationsForDb`/`unreadNoticeCountDb`'s own suite
 * (notifications.test.ts) covers the visibility rule itself; this file only
 * checks that `attentionDb` wires it in, including for the unlinked case.
 */
describe("attentionDb notices", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table notice_reads, notice_read_marks`);
    await db.execute(sql`delete from clan_notices where discord_target_id like 'u-attn-%'`);
    await db.execute(sql`delete from identity_links where discord_id like 'u-attn-%'`);
    await db.execute(sql`insert into servers (id, name, map, clock_offset_ms, active) overriding system value
                         values (942, 'attn-942', 'livonia', 0, true) on conflict do nothing`);
  });

  const dm = (at: string) =>
    db.execute(sql`insert into clan_notices (server_id, faction_id, target, discord_target_id, kind, occurred_at, payload)
                   values (942, null, 'dm', ${YOU}, 'invited', ${at}, '{"clan":"Iron Wolves"}'::jsonb)`);

  it("is 0 with nothing waiting", async () => {
    const a = await attentionDb(db, YOU, NOW);
    expect(a.notices).toBe(0);
  });

  it("counts an unread notice", async () => {
    await dm("2026-09-18T10:00:00Z");
    const a = await attentionDb(db, YOU, NOW);
    expect(a.notices).toBe(1);
  });

  /**
   * ⚠️ Notices are keyed on discord_id, not dayz_id — an invite can arrive
   * before a link does. Returning 0 for an unlinked player would hide the
   * bell from exactly the player who most needs to see it.
   */
  it("⚠️ still counts for a player with no identity link yet", async () => {
    await dm("2026-09-18T10:00:00Z");
    const [link] = await db.select().from(identityLinks).where(sql`discord_id = ${YOU}`);
    expect(link).toBeUndefined();
    const a = await attentionDb(db, YOU, NOW);
    expect(a.notices).toBe(1);
  });
});
