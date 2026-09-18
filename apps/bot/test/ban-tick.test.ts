import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, bans, servers, identityLinks, clanNotices, banAnnouncements, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { banTick, type BanTarget } from "../src/ban-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const DAYZ_ID = "76561198000000001";

function fakeClient(impl?: { addBans?: (n: string[]) => Promise<void>; removeBans?: (n: string[]) => Promise<void> }): BanTarget & { added: string[][]; removed: string[][] } {
  const added: string[][] = [];
  const removed: string[][] = [];
  return {
    added,
    removed,
    addBans: vi.fn(async (names: string[]) => {
      if (impl?.addBans) { await impl.addBans(names); }
      added.push(names);
    }),
    removeBans: vi.fn(async (names: string[]) => {
      if (impl?.removeBans) { await impl.removeBans(names); }
      removed.push(names);
    }),
  };
}

describe("banTick", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table bans, clan_notices, identity_links, servers, ban_announcements restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 1, active: true }).returning();
    serverId = s!.id;
  });

  async function insertBan(overrides: Partial<typeof bans.$inferInsert> = {}) {
    const [row] = await db.insert(bans).values({
      serverId,
      dayzId: DAYZ_ID,
      gamertag: "Sasha",
      bannedAt: at("2026-09-15T00:00:00Z"),
      expiresAt: null,
      status: "pending",
      ...overrides,
    }).returning();
    return row!;
  }

  const allRows = () => db.select().from(bans);
  const activeStatuses = async () => (await allRows()).map((r) => r.status);

  it("applies a pending ban: one addBans carrying BOTH the dayzId and the gamertag", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z") });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.applied).toBe(1);
    expect(fake.added).toEqual([[DAYZ_ID, "Sasha"]]);
    expect((await allRows())[0]).toMatchObject({ status: "applied", dryRun: false });
  });

  it("a dry-run row is never sent to Nitrado but is still marked applied", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z") });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: true, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.applied).toBe(1);
    expect(fake.added).toEqual([]);
    expect((await allRows())[0]).toMatchObject({ status: "applied", dryRun: true });
  });

  it("a real (non-dry-run) apply writes exactly one `applied` ban_announcements row with the right payload", async () => {
    const row = await insertBan({ bannedAt: at("2026-09-15T01:00:00Z"), expiresAt: at("2026-09-20T00:00:00Z"), reason: "zone" });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.applied).toBe(1);
    const rows = await db.select().from(banAnnouncements);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serverId,
      banId: row.id,
      kind: "applied",
      payload: { gamertag: "Sasha", reason: "zone", expiresAt: "2026-09-20T00:00:00.000Z" },
    });
  });

  // ⚠️ The most important test in this file: a dry-run ban never reached
  // Nitrado, so a public `#bans` announcement for it would tell players a
  // ban happened that did not.
  it("⚠️ a dry-run apply writes NO ban_announcements row", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z") });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: true, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.applied).toBe(1);
    expect(await db.select().from(banAnnouncements)).toHaveLength(0);
  });

  it("a ban that fails to apply (Nitrado throws) writes NO ban_announcements row", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z"), attempts: 2 });
    const fake = fakeClient({ addBans: async () => { throw new Error("nitrado down"); } });
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.failed).toBe(1);
    expect(await db.select().from(banAnnouncements)).toHaveLength(0);
  });

  it("a permanent ban's ban_announcements payload has expiresAt: null", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z"), expiresAt: null });
    const fake = fakeClient();
    await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    const [row] = await db.select().from(banAnnouncements);
    expect(row!.payload).toMatchObject({ expiresAt: null });
  });

  it("does not apply rows older than `since` — a dry-run flip must not fire the backlog", async () => {
    // Banned well before `since`: represents historical backlog written while dry-run was on.
    await insertBan({ bannedAt: at("2026-08-01T00:00:00Z") });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.applied).toBe(0);
    expect(fake.added).toEqual([]);
    // Never sent to Nitrado — but it does NOT sit `pending` forever either: the
    // age-out arm below moves it to `failed`, so it stops silently counting as
    // an active, soon-to-apply ban.
    expect((await allRows())[0]).toMatchObject({ status: "failed" });
  });

  it("ages a pending row out to failed when bannedAt predates `since`, without touching Nitrado", async () => {
    const old = await insertBan({ bannedAt: at("2026-08-01T00:00:00Z") });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.failed).toBe(1);
    expect(fake.added).toEqual([]);
    const row = (await allRows()).find((x) => x.id === old.id)!;
    expect(row.status).toBe("failed");
    expect(row.lastError).toMatch(/aged out/u);
  });

  it("an aged-out row does not block a newer pending row from applying in the same tick", async () => {
    const old = await insertBan({ bannedAt: at("2026-08-01T00:00:00Z"), gamertag: "Old", dayzId: "76561198000000002" });
    const fresh = await insertBan({ bannedAt: at("2026-09-15T01:00:00Z") });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.failed).toBe(1);
    expect(r.applied).toBe(1);
    expect(fake.added).toEqual([[DAYZ_ID, "Sasha"]]);
    const rows = await allRows();
    expect(rows.find((x) => x.id === old.id)!.status).toBe("failed");
    expect(rows.find((x) => x.id === fresh.id)!.status).toBe("applied");
  });

  it("an expired ban is removed and marked expired", async () => {
    await insertBan({
      status: "applied",
      dryRun: false,
      appliedAt: at("2026-09-01T00:00:00Z"),
      expiresAt: at("2026-09-10T00:00:00Z"),
    });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
    expect(r.expired).toBe(1);
    expect(fake.removed).toEqual([[DAYZ_ID, "Sasha"]]);
    expect((await allRows())[0]).toMatchObject({ status: "expired" });
  });

  it("an expiry writes exactly one `expired` ban_announcements row with the right payload", async () => {
    const row = await insertBan({
      status: "applied",
      dryRun: false,
      appliedAt: at("2026-09-01T00:00:00Z"),
      expiresAt: at("2026-09-10T00:00:00Z"),
      reason: "zone",
    });
    const fake = fakeClient();
    await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
    const rows = await db.select().from(banAnnouncements);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serverId,
      banId: row.id,
      kind: "expired",
      payload: { gamertag: "Sasha", reason: "zone", expiresAt: "2026-09-10T00:00:00.000Z" },
    });
  });

  it("a dry-run row's expiry writes NO ban_announcements row — it never reached Nitrado", async () => {
    await insertBan({
      status: "applied",
      dryRun: true,
      appliedAt: at("2026-09-01T00:00:00Z"),
      expiresAt: at("2026-09-10T00:00:00Z"),
    });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
    expect(r.expired).toBe(1);
    expect(await db.select().from(banAnnouncements)).toHaveLength(0);
  });

  it("a permanent ban (expiresAt null) is never expired", async () => {
    await insertBan({
      status: "applied",
      dryRun: false,
      appliedAt: at("2026-09-01T00:00:00Z"),
      expiresAt: null,
    });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
    expect(r.expired).toBe(0);
    expect(fake.removed).toEqual([]);
    expect((await allRows())[0]).toMatchObject({ status: "applied" });
  });

  it("two overlapping bans on one account: the earlier expiry does NOT free the later ban", async () => {
    // Earlier ban, expiring now.
    await insertBan({
      status: "applied",
      dryRun: false,
      appliedAt: at("2026-09-01T00:00:00Z"),
      expiresAt: at("2026-09-15T00:00:00Z"),
    });
    // Later, still-active ban on the SAME dayzId, expiring well after `now`.
    await insertBan({
      status: "applied",
      dryRun: false,
      appliedAt: at("2026-09-10T00:00:00Z"),
      expiresAt: at("2026-09-20T00:00:00Z"),
    });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
    expect(r.expired).toBe(1);
    expect(fake.removed).toEqual([]);
    expect(await activeStatuses()).toContain("applied");
  });

  it("a Nitrado error increments attempts and leaves the row retryable", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z") });
    const fake = fakeClient({ addBans: async () => { throw new Error("nitrado down"); } });
    await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect((await allRows())[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("BAN_MAX_ATTEMPTS errors move the row to failed, not pending", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z"), attempts: 2 });
    const fake = fakeClient({ addBans: async () => { throw new Error("nitrado down"); } });
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.failed).toBe(1);
    expect((await allRows())[0]).toMatchObject({ status: "failed", attempts: 3 });
  });

  // IMPORTANT 3 regression: `addBans` is a whole-field read-modify-write —
  // if the write actually lands but the response is lost, the client throws
  // anyway, attempts climb to BAN_MAX_ATTEMPTS, and the row goes `failed`
  // with a LIVE entry still on the Nitrado list. The expire/lift arms only
  // ever select `applied`/`lift_pending` rows, so that entry would be
  // orphaned forever without a best-effort cleanup here.
  it("a row that fails out to `failed` gets a best-effort removeBans cleanup", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z"), attempts: 2, dryRun: false });
    const fake = fakeClient({ addBans: async () => { throw new Error("nitrado down"); } });
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.failed).toBe(1);
    expect(fake.removed).toEqual([[DAYZ_ID, "Sasha"]]);
  });

  it("the failed-row cleanup is guarded by stillBanned — a second live ban on the same account keeps its entry", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z"), attempts: 2 });
    await insertBan({
      bannedAt: at("2026-09-14T00:00:00Z"), status: "applied", dryRun: false,
      appliedAt: at("2026-09-14T00:00:00Z"), expiresAt: null,
    });
    const fake = fakeClient({ addBans: async () => { throw new Error("nitrado down"); } });
    await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(fake.removed).toEqual([]);
  });

  it("a dry-run row that fails out to `failed` is never sent to removeBans — it never reached Nitrado", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z"), attempts: 2, dryRun: true });
    const fake = fakeClient({ addBans: async () => { throw new Error("should never be called in dry-run"); } });
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: true, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.failed).toBe(0);   // dry-run rows are always "applied" locally; nothing to fail here
    expect(fake.removed).toEqual([]);
  });

  // IMPORTANT 6 regression: `ban_applied` was rendered by notice-text.ts and
  // never emitted anywhere — the offender got a pre-charge heads-up (the
  // zone_warning DM) and then silently could not connect.
  it("a genuinely-applied (non-dry-run) ban notifies the offender's linked Discord id", async () => {
    await db.insert(identityLinks).values({ discordId: "d-offender", dayzId: DAYZ_ID, gamertag: "Sasha", verifiedAt: at("2026-09-01T00:00:00Z") });
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z"), expiresAt: at("2026-09-16T01:00:00Z") });
    const fake = fakeClient();
    await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    const [notice] = await db.select().from(clanNotices).where(eq(clanNotices.kind, "ban_applied"));
    expect(notice).toBeTruthy();
    expect(notice!.target).toBe("dm");
    expect(notice!.discordTargetId).toBe("d-offender");
    expect(notice!.payload).not.toHaveProperty("x");
    expect(notice!.payload).not.toHaveProperty("poleKey");
  });

  it("a dry-run apply never notifies the offender — nothing actually happened", async () => {
    await db.insert(identityLinks).values({ discordId: "d-offender", dayzId: DAYZ_ID, gamertag: "Sasha", verifiedAt: at("2026-09-01T00:00:00Z") });
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z") });
    const fake = fakeClient();
    await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: true, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(await db.select().from(clanNotices).where(eq(clanNotices.kind, "ban_applied"))).toHaveLength(0);
  });

  it("an unlinked offender's applied ban notifies nobody, silently", async () => {
    await insertBan({ bannedAt: at("2026-09-15T01:00:00Z") });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
    expect(r.applied).toBe(1);
    expect(await db.select().from(clanNotices).where(eq(clanNotices.kind, "ban_applied"))).toHaveLength(0);
  });

  it("a lift_pending row is removed and becomes lifted only after Nitrado confirms", async () => {
    await insertBan({
      status: "lift_pending",
      dryRun: false,
      appliedAt: at("2026-09-01T00:00:00Z"),
      expiresAt: null,
    });
    const fake = fakeClient();
    await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
    expect(fake.removed).toEqual([[DAYZ_ID, "Sasha"]]);
    const row = (await allRows())[0]!;
    expect(row.status).toBe("lifted");
    expect(row.liftedAt).not.toBeNull();
  });

  it("a lift writes exactly one `lifted` ban_announcements row with the right payload", async () => {
    const row = await insertBan({
      status: "lift_pending",
      dryRun: false,
      appliedAt: at("2026-09-01T00:00:00Z"),
      expiresAt: null,
      reason: "unlinked_pc",
    });
    const fake = fakeClient();
    await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
    const rows = await db.select().from(banAnnouncements);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serverId,
      banId: row.id,
      kind: "lifted",
      payload: { gamertag: "Sasha", reason: "unlinked_pc", expiresAt: null },
    });
  });

  it("a dry-run row's lift writes NO ban_announcements row — it was never really banned", async () => {
    await insertBan({
      status: "lift_pending",
      dryRun: true,
      appliedAt: at("2026-09-01T00:00:00Z"),
      expiresAt: null,
    });
    const fake = fakeClient();
    await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
    expect(await db.select().from(banAnnouncements)).toHaveLength(0);
  });

  // ⚠️ Regression: the announcement used to be gated on `!row.dryRun` alone,
  // so the FIRST of two concurrent real bans to close posted "unbanned" while
  // the account was still on Nitrado's list — a public message saying
  // something untrue about a real player.
  it("two concurrent real bans: the first to expire removes nothing and announces nothing", async () => {
    const first = await insertBan({
      status: "applied", dryRun: false,
      appliedAt: at("2026-09-01T00:00:00Z"), expiresAt: at("2026-09-15T00:00:00Z"), reason: "zone",
    });
    await insertBan({
      status: "applied", dryRun: false,
      appliedAt: at("2026-09-01T00:00:00Z"), expiresAt: null, reason: "unlinked_pc",
    });
    const fake = fakeClient();
    const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
    expect(r.expired).toBe(1);
    expect(fake.removed).toEqual([]);   // the shared list entry stays: the PC ban is still in force
    const firstRow = (await allRows()).find((row) => row.id === first.id)!;
    expect(firstRow.status).toBe("expired");
    expect(await db.select().from(banAnnouncements)).toHaveLength(0);
  });

  it("…and closing the SECOND one removes the entry and yields exactly ONE unban announcement in total", async () => {
    const first = await insertBan({
      status: "applied", dryRun: false,
      appliedAt: at("2026-09-01T00:00:00Z"), expiresAt: at("2026-09-15T00:00:00Z"), reason: "zone",
    });
    const second = await insertBan({
      status: "applied", dryRun: false,
      appliedAt: at("2026-09-01T00:00:00Z"), expiresAt: null, reason: "unlinked_pc",
    });
    const fake = fakeClient();
    await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });

    // The PC ban is lifted (the player linked): now nothing else holds the entry.
    await db.update(bans).set({ status: "lift_pending" }).where(eq(bans.id, second.id));
    const r = await banTick(db, fake, { now: at("2026-09-15T03:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
    expect(r.expired).toBe(0);
    expect(fake.removed).toEqual([[DAYZ_ID, "Sasha"]]);

    // Exactly ONE unban message for this account across BOTH ticks, and it is
    // the one belonging to the ban that actually took the entry off the list.
    const announcements = await db.select().from(banAnnouncements);
    const unbans = announcements.filter((a) => a.kind === "lifted" || a.kind === "expired");
    expect(unbans).toHaveLength(1);
    expect(unbans[0]).toMatchObject({ banId: second.id, kind: "lifted" });
    expect(unbans.filter((a) => a.banId === first.id)).toHaveLength(0);
  });

  describe("multi-server isolation", () => {
    let server2Id = 0;

    beforeEach(async () => {
      const [s2] = await db.insert(servers).values({ name: "S2", map: "chernarusplus", clockOffsetMs: 0, nitradoServiceId: 2, active: true }).returning();
      server2Id = s2!.id;
    });

    it("⚠️ a tick for server 1 never applies, expires, or lifts server 2's rows", async () => {
      // Pending on server 2 only — server 1's tick must not touch it.
      await insertBan({ serverId: server2Id, bannedAt: at("2026-09-15T01:00:00Z") });
      const fake = fakeClient();
      const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-09-15T00:00:00Z"), serverId });
      expect(r.applied).toBe(0);
      expect(fake.added).toEqual([]);
      expect((await allRows())[0]).toMatchObject({ serverId: server2Id, status: "pending" });
    });

    it("⚠️ stillBanned does not let another server's active ban block THIS server's removal — the unliftable-ban regression", async () => {
      // Server 1: a ban on DAYZ_ID due to expire right now.
      await insertBan({
        serverId,
        status: "applied",
        dryRun: false,
        appliedAt: at("2026-09-01T00:00:00Z"),
        expiresAt: at("2026-09-15T00:00:00Z"),
      });
      // Server 2: a DIFFERENT, still-active ban on the SAME dayzId. Before the
      // serverId filter, stillBanned would see this row and refuse to ever
      // remove server 1's list entry — an unliftable ban on server 1 caused
      // by a ban that has nothing to do with server 1.
      await insertBan({
        serverId: server2Id,
        status: "applied",
        dryRun: false,
        appliedAt: at("2026-09-01T00:00:00Z"),
        expiresAt: null,
      });
      const fake = fakeClient();
      const r = await banTick(db, fake, { now: at("2026-09-15T02:00:00Z"), dryRun: false, since: at("2026-08-01T00:00:00Z"), serverId });
      expect(r.expired).toBe(1);
      expect(fake.removed).toEqual([[DAYZ_ID, "Sasha"]]);
      const server1Row = (await allRows()).find((row) => row.serverId === serverId)!;
      const server2Row = (await allRows()).find((row) => row.serverId === server2Id)!;
      expect(server1Row.status).toBe("expired");
      expect(server2Row.status).toBe("applied"); // untouched
    });
  });
});
