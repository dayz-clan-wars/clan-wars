import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, noticeReadMarks, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { notificationsForDb, unreadNoticeCountDb, markAllNoticesReadDb, markNoticeReadDb } from "../src/notifications";

const URL = requireTestDatabaseUrl();
const YOU = "u-you";
const AT = (iso: string) => new Date(iso);

describe("notificationsForDb", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table notice_reads, notice_read_marks`);
    await db.execute(sql`delete from clan_notices where discord_target_id like 'u-%' or faction_id in (select id from factions where tag like 'NT%')`);
    await db.execute(sql`delete from faction_members where discord_id like 'u-%' or faction_id in (select id from factions where tag like 'NT%')`);
    // ⚠️ The brief's fixture never dropped its own factions between tests, and
    // each `it()` reuses the tag as its texture too — both are covered by
    // `factions_holding_texture_uniq`/`factions_holding_tag_uniq` (server_id,
    // texture/lower(tag), while status is a holding status), so a run's
    // second faction() call collided with the first's leftover row, and a
    // second full test run collided with the first run's. Drop them here.
    await db.execute(sql`delete from factions where tag like 'NT%'`);
    await db.execute(sql`insert into servers (id, name, map, clock_offset_ms, active) overriding system value
                         values (941, 'ntf-941', 'livonia', 0, true) on conflict do nothing`);
  });

  // Columns verified against packages/db/src/schema.ts:502 — `texture`, not
  // `flag`, and leader_discord_id is NOT NULL with no default.
  //
  // ⚠️ `factions_holding_texture_uniq` is a real unique index (server_id,
  // texture) among holding statuses, and beforeEach never deletes prior
  // tests' faction rows (only their notices and 'u-%' members) — a shared
  // literal texture across tests collides on the second `it()`. The tag is
  // already unique per test, so it doubles as the texture.
  const faction = async (tag: string): Promise<number> => {
    const [f] = await db.execute<{ id: string }>(sql`
      insert into factions (server_id, name, tag, texture, status, leader_discord_id, created_at)
      values (941, ${`Notif ${tag}`}, ${tag}, ${tag}, 'active', 'u-leader', now()) returning id`);
    return Number(f!.id);
  };

  // ⚠️ postgres.js in this repo's driver stack cannot bind a raw JS `Date`
  // through drizzle's `sql` tag (it throws inside its own parameter encoder,
  // not a column-type error) — `.toISOString()` sidesteps it. `db.insert()`'s
  // typed column path (used for noticeReadMarks below) is unaffected.
  const member = (factionId: number, joinedAt: Date, status = "full") =>
    db.execute(sql`insert into faction_members (faction_id, server_id, dayz_id, discord_id, role, joined_at, status)
                   values (${factionId}, 941, ${`dz-${YOU}`}, ${YOU}, 'member', ${joinedAt.toISOString()}, ${status})`);

  const dm = (at: Date, to = YOU) =>
    db.execute(sql`insert into clan_notices (server_id, faction_id, target, discord_target_id, kind, occurred_at, payload)
                   values (941, null, 'dm', ${to}, 'invited', ${at.toISOString()}, '{"clan":"Iron Wolves"}'::jsonb)`);

  const channel = (factionId: number, at: Date) =>
    db.execute(sql`insert into clan_notices (server_id, faction_id, target, discord_target_id, kind, occurred_at, payload)
                   values (941, ${factionId}, 'channel', null, 'promoted', ${at.toISOString()}, '{"gamertag":"Ada"}'::jsonb)`);

  it("returns your DMs", async () => {
    await dm(AT("2026-09-18T10:00:00Z"));
    const p = await notificationsForDb(db, YOU, 1);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.kind).toBe("invited");
  });

  it("never returns someone else's DM", async () => {
    await dm(AT("2026-09-18T10:00:00Z"), "u-someone-else");
    expect((await notificationsForDb(db, YOU, 1)).rows).toHaveLength(0);
  });

  it("returns your clan's channel notices", async () => {
    const f = await faction("NTA");
    await member(f, AT("2026-09-01T00:00:00Z"));
    await channel(f, AT("2026-09-18T10:00:00Z"));
    const p = await notificationsForDb(db, YOU, 1);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.kind).toBe("promoted");
  });

  /**
   * ⚠️ The privacy rule (spec §3). Without the joined_at floor, joining a clan
   * hands you everything it ever received: who was kicked, who was demoted,
   * every raid it lost. This is the test a future query rewrite is most likely
   * to lose.
   */
  it("⚠️ never returns a channel notice from before you joined", async () => {
    const f = await faction("NTB");
    await member(f, AT("2026-09-10T00:00:00Z"));
    await channel(f, AT("2026-09-09T23:59:59Z"));
    await channel(f, AT("2026-09-10T00:00:01Z"));
    const p = await notificationsForDb(db, YOU, 1);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.occurredAt.toISOString()).toBe("2026-09-10T00:00:01.000Z");
  });

  /**
   * ⚠️ faction_members carries its own ⚠️: every "is a member" read means
   * status = 'full'. A pending member is on the table and not on the roster,
   * and must not read the clan's channel history.
   */
  it("⚠️ gives a pending member nothing from the channel", async () => {
    const f = await faction("NTC");
    await member(f, AT("2026-09-01T00:00:00Z"), "pending");
    await channel(f, AT("2026-09-18T10:00:00Z"));
    expect((await notificationsForDb(db, YOU, 1)).rows).toHaveLength(0);
  });

  it("orders newest first across both halves", async () => {
    const f = await faction("NTD");
    await member(f, AT("2026-09-01T00:00:00Z"));
    await dm(AT("2026-09-18T09:00:00Z"));
    await channel(f, AT("2026-09-18T11:00:00Z"));
    const p = await notificationsForDb(db, YOU, 1);
    expect(p.rows.map((r) => r.kind)).toEqual(["promoted", "invited"]);
  });

  it("is unread until the watermark covers it", async () => {
    await dm(AT("2026-09-18T10:00:00Z"));
    expect((await notificationsForDb(db, YOU, 1)).rows[0]!.unread).toBe(true);
    expect(await unreadNoticeCountDb(db, YOU)).toBe(1);

    const [row] = await db.execute<{ id: string }>(sql`select max(id) as id from clan_notices`);
    await db.insert(noticeReadMarks).values({ discordId: YOU, throughId: Number(row!.id) });

    expect((await notificationsForDb(db, YOU, 1)).rows[0]!.unread).toBe(false);
    expect(await unreadNoticeCountDb(db, YOU)).toBe(0);
  });

  /**
   * ⚠️ The watermark must not swallow what arrived after it. This is why
   * through_id is an id and not a timestamp — see the schema's ⚠️.
   */
  it("⚠️ leaves a notice that arrived after the mark unread", async () => {
    await dm(AT("2026-09-18T10:00:00Z"));
    const [row] = await db.execute<{ id: string }>(sql`select max(id) as id from clan_notices`);
    await db.insert(noticeReadMarks).values({ discordId: YOU, throughId: Number(row!.id) });
    await dm(AT("2026-09-18T11:00:00Z"));

    const p = await notificationsForDb(db, YOU, 1);
    expect(p.rows.map((r) => r.unread)).toEqual([true, false]);
    expect(await unreadNoticeCountDb(db, YOU)).toBe(1);
  });

  it("pages, and says whether there is another", async () => {
    for (let i = 0; i < 51; i++) await dm(new Date(Date.UTC(2026, 8, 18, 0, i)));
    const p1 = await notificationsForDb(db, YOU, 1);
    expect(p1.rows).toHaveLength(50);
    expect(p1.hasNext).toBe(true);
    const p2 = await notificationsForDb(db, YOU, 2);
    expect(p2.rows).toHaveLength(1);
    expect(p2.hasNext).toBe(false);
  });

  it("is empty, not an error, for a player with nothing", async () => {
    const p = await notificationsForDb(db, "u-nobody", 1);
    expect(p.rows).toEqual([]);
    expect(p.hasNext).toBe(false);
    expect(await unreadNoticeCountDb(db, "u-nobody")).toBe(0);
  });

  // Nested (not a sibling describe) so `db`, `dm`, `channel`, `member` and
  // `faction` — all closed over from the outer describe's beforeEach — stay
  // in scope. A sibling describe cannot see consts declared inside another
  // describe's callback.
  describe("marking read", () => {
    it("mark-all writes ONE row and covers everything present", async () => {
      await dm(AT("2026-09-18T10:00:00Z"));
      await dm(AT("2026-09-18T11:00:00Z"));
      await markAllNoticesReadDb(db, YOU);

      expect(await unreadNoticeCountDb(db, YOU)).toBe(0);
      const marks = await db.execute<{ n: string }>(sql`select count(*) as n from notice_read_marks where discord_id = ${YOU}`);
      expect(Number([...marks][0]!.n)).toBe(1);
      const reads = await db.execute<{ n: string }>(sql`select count(*) as n from notice_reads where discord_id = ${YOU}`);
      expect(Number([...reads][0]!.n)).toBe(0);
    });

    it("mark-all twice moves the watermark rather than adding a row", async () => {
      await dm(AT("2026-09-18T10:00:00Z"));
      await markAllNoticesReadDb(db, YOU);
      await dm(AT("2026-09-18T12:00:00Z"));
      expect(await unreadNoticeCountDb(db, YOU)).toBe(1);
      await markAllNoticesReadDb(db, YOU);
      expect(await unreadNoticeCountDb(db, YOU)).toBe(0);
      const marks = await db.execute<{ n: string }>(sql`select count(*) as n from notice_read_marks where discord_id = ${YOU}`);
      expect(Number([...marks][0]!.n)).toBe(1);
    });

    it("marks one notice read without touching the rest", async () => {
      await dm(AT("2026-09-18T10:00:00Z"));
      await dm(AT("2026-09-18T11:00:00Z"));
      const p = await notificationsForDb(db, YOU, 1);
      await markNoticeReadDb(db, YOU, p.rows[0]!.id);
      expect(await unreadNoticeCountDb(db, YOU)).toBe(1);
    });

    it("marking the same notice twice is harmless", async () => {
      await dm(AT("2026-09-18T10:00:00Z"));
      const p = await notificationsForDb(db, YOU, 1);
      await markNoticeReadDb(db, YOU, p.rows[0]!.id);
      await markNoticeReadDb(db, YOU, p.rows[0]!.id);
      expect(await unreadNoticeCountDb(db, YOU)).toBe(0);
    });

    /**
     * ⚠️ The foreign notice is inserted AFTER the viewer's, so it holds the HIGHER
     * id and global max(clan_notices.id) genuinely differs from this viewer's max.
     * Inserted the other way round the two implementations agree and the test proves
     * nothing — which is exactly how this test read before.
     */
    it("⚠️ caps the watermark at what this viewer can actually see", async () => {
      await dm(AT("2026-09-18T09:00:00Z"));
      const [mine] = await db.execute<{ id: string }>(sql`select max(id) as id from clan_notices where discord_target_id = ${YOU}`);
      await dm(AT("2026-09-18T10:00:00Z"), "u-someone-else");
      const [everything] = await db.execute<{ id: string }>(sql`select max(id) as id from clan_notices`);
      // The fixture itself must diverge, or the assertion below is vacuous.
      expect(Number(everything!.id)).toBeGreaterThan(Number(mine!.id));

      await markAllNoticesReadDb(db, YOU);

      const [mark] = await db.execute<{ through_id: string }>(sql`select through_id from notice_read_marks where discord_id = ${YOU}`);
      expect(Number(mark!.through_id)).toBe(Number(mine!.id));

      // And the behaviour that follows from it: a notice arriving later is still unread.
      await dm(AT("2026-09-18T11:00:00Z"));
      expect(await unreadNoticeCountDb(db, YOU)).toBe(1);
    });

    /**
     * ⚠️ A guessed id must write nothing and raise nothing. Silence is the point:
     * an error would tell a prober the notice exists.
     */
    it("⚠️ marking a notice you cannot see writes nothing and does not throw", async () => {
      await dm(AT("2026-09-18T10:00:00Z"), "u-someone-else");
      const [theirs] = await db.execute<{ id: string }>(sql`select max(id) as id from clan_notices`);
      await markNoticeReadDb(db, YOU, Number(theirs!.id));
      const rows = await db.execute<{ n: string }>(sql`select count(*) as n from notice_reads where discord_id = ${YOU}`);
      expect(Number([...rows][0]!.n)).toBe(0);
    });
  });
});
