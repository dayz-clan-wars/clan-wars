import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, noticeReads, noticeReadMarks, type Database } from "@factions/db";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();

describe("notice read state", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table notice_reads, notice_read_marks`);
  });

  it("marks one notice read, idempotently", async () => {
    await db.insert(noticeReads).values({ discordId: "d1", noticeId: 1 }).onConflictDoNothing();
    await db.insert(noticeReads).values({ discordId: "d1", noticeId: 1 }).onConflictDoNothing();
    const rows = await db.select().from(noticeReads);
    expect(rows).toHaveLength(1);
  });

  /**
   * ⚠️ The watermark is one row per player, not per notice. A clan member with
   * thousands of notices behind them must not write thousands of rows to press
   * one button — see spec §2.
   */
  it("⚠️ keeps exactly one watermark row per player, updated in place", async () => {
    await db.insert(noticeReadMarks).values({ discordId: "d1", throughId: 10 });
    await db.insert(noticeReadMarks).values({ discordId: "d1", throughId: 99 })
      .onConflictDoUpdate({ target: noticeReadMarks.discordId, set: { throughId: 99 } });
    const rows = await db.select().from(noticeReadMarks);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.throughId).toBe(99);
  });

  /**
   * ⚠️ notice_reads cascades because a read row for a deleted notice is
   * meaningless. The watermark deliberately has NO foreign key: it points at
   * the highest id the player had seen, and must survive that row being wiped.
   */
  it("⚠️ cascades reads when a notice is deleted, but never the watermark", async () => {
    await db.execute(sql`insert into servers (id, name, map, clock_offset_ms, active) overriding system value
                         values (940, 'nr-940', 'livonia', 0, true) on conflict do nothing`);
    const [n] = await db.execute<{ id: string }>(sql`
      insert into clan_notices (server_id, faction_id, target, discord_target_id, kind, occurred_at, payload)
      values (940, null, 'dm', 'd1', 'invited', now(), '{}'::jsonb) returning id`);
    const noticeId = Number(n!.id);

    await db.insert(noticeReads).values({ discordId: "d1", noticeId });
    await db.insert(noticeReadMarks).values({ discordId: "d1", throughId: noticeId });

    await db.execute(sql`delete from clan_notices where id = ${noticeId}`);

    expect(await db.select().from(noticeReads)).toHaveLength(0);
    expect(await db.select().from(noticeReadMarks)).toHaveLength(1);
  });
});
