import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, admFiles, bans, events, identityLinkEnds, identityLinks,
  players, playerSessions, servers, verificationChallenges, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { linkGateTick, linkGateOpsLines } from "../src/link-gate-tick.js";
import { banTick, type BanTarget } from "../src/ban-tick.js";

const URL = requireTestDatabaseUrl();
const P = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MIN = 60_000;
const HOUR = 60 * MIN;
// A clock start of our own, so `now` can be fixed (the real launch constant is
// in the future of some test runs and the past of others).
const FROM = new Date("2026-11-01T00:00:00Z");
const NOW = new Date("2026-11-02T12:00:00Z");
const at = (ms: number) => new Date(FROM.getTime() + ms);

describe("linkGateTick", () => {
  let db: Database;
  let serverId: number;
  let line: number;

  const tick = (now = NOW, write = true) => linkGateTick(db, { serverId, now, write, from: FROM });

  const session = async (dayzId: string, from: Date, to: Date | null) => {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: from, payload: {},
    }).returning({ id: events.id });
    await db.insert(playerSessions).values({
      serverId, dayzId, connectedAt: from, connectEventId: ev!.id, disconnectedAt: to, closeReason: to ? "disconnect" : null,
    });
  };
  const challenge = (dayzId: string, discordId: string, issuedAt: Date) =>
    db.insert(verificationChallenges).values({
      discordId, sequence: ["a", "b", "c"], issuedAt, expiresAt: new Date(issuedAt.getTime() + 24 * HOUR), targetDayzId: dayzId,
    } as never);
  const ban = (values: Partial<typeof bans.$inferInsert>) =>
    db.insert(bans).values({ serverId, dayzId: P, gamertag: "Unlinked", bannedAt: at(2 * HOUR), status: "applied", reason: "unlinked", ...values } as never);
  const link = () => db.insert(identityLinks).values({ discordId: "d9", dayzId: P, gamertag: "Unlinked", verifiedAt: NOW });
  const allBans = () => db.select().from(bans).orderBy(bans.id);

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate player_sessions, players, identity_links, identity_link_ends, verification_challenges, bans, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "nasdara", clockOffsetMs: 0, nitradoServiceId: 1, active: true }).returning();
    serverId = s!.id;
    line = 0;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: FROM, linesIngested: 0, complete: true });
    await db.insert(players).values({ dayzId: P, gamertag: "Unlinked", firstSeenAt: FROM, lastSeenAt: FROM });
  });

  it("bans after 61 minutes of unlinked play since the clock start, summed across sessions", async () => {
    await session(P, at(HOUR), at(HOUR + 30 * MIN));
    await session(P, at(3 * HOUR), at(3 * HOUR + 31 * MIN));
    const r = await tick();
    expect(r.banned).toEqual([{ dayzId: P, gamertag: "Unlinked" }]);
    const [row] = await allBans();
    expect(row).toMatchObject({ reason: "unlinked", status: "pending", expiresAt: null, gamertag: "Unlinked", dayzId: P });
  });

  it("does not ban at 59 minutes, and play before the clock start never counts", async () => {
    await session(P, new Date(FROM.getTime() - 5 * HOUR), new Date(FROM.getTime() - 1 * MIN));
    // Straddles FROM: only the 29 minutes after it count.
    await session(P, new Date(FROM.getTime() - 30 * MIN), at(29 * MIN));
    await session(P, at(HOUR), at(HOUR + 30 * MIN));
    expect((await tick()).banned).toEqual([]);
    expect(await allBans()).toEqual([]);
  });

  it("an open session runs up to now", async () => {
    await session(P, new Date(NOW.getTime() - 61 * MIN), null);
    expect((await tick()).banned.map((b) => b.dayzId)).toEqual([P]);
  });

  it("bans at once when a link was lost after the clock start, with no play at all", async () => {
    await link();
    await db.delete(identityLinks);   // the trigger records the end
    await db.update(identityLinkEnds).set({ endedAt: at(HOUR) });
    expect((await tick()).banned.map((b) => b.dayzId)).toEqual([P]);
  });

  it("a link lost before the clock start does not ban", async () => {
    await link();
    await db.delete(identityLinks);
    await db.update(identityLinkEnds).set({ endedAt: new Date(FROM.getTime() - HOUR) });
    expect((await tick()).banned).toEqual([]);
  });

  it("does not write a second ban while one is active", async () => {
    await session(P, at(HOUR), at(3 * HOUR));
    await tick();
    await tick();
    expect(await allBans()).toHaveLength(1);
  });

  it("lifts an applied ban on a live attempt, and only once a day whoever opens the next one", async () => {
    await session(P, at(HOUR), at(3 * HOUR));
    await ban({});
    await challenge(P, "d1", NOW);
    const r = await tick();
    expect(r.lifted.map((b) => b.dayzId)).toEqual([P]);
    expect((await allBans())[0]!.status).toBe("lift_pending");

    // banTick lifts it; the first attempt is cancelled and the hour runs out.
    await db.update(bans).set({ status: "lifted", liftedAt: NOW });
    await db.update(verificationChallenges).set({ canceledAt: NOW });
    const later = new Date(NOW.getTime() + 61 * MIN);
    expect((await tick(later)).banned.map((b) => b.dayzId)).toEqual([P]);
    // banTick applies the new ban, then a different Discord account opens an attempt.
    await db.update(bans).set({ status: "applied" }).where(eq(bans.status, "pending"));
    await challenge(P, "d2", later);
    const again = await tick(new Date(later.getTime() + 5 * MIN));
    expect(again.lifted).toEqual([]);
    expect((await allBans()).map((b) => b.status)).toEqual(["lifted", "applied"]);
  });

  it("a second attempt while the first lift is still lift_pending does not lift again", async () => {
    await ban({ status: "lift_pending" });
    await ban({ status: "applied", bannedAt: at(3 * HOUR) });
    await challenge(P, "d2", NOW);
    expect((await tick()).lifted).toEqual([]);
  });

  it("does not ban during the lift hour while the attempt is live", async () => {
    await session(P, at(HOUR), at(3 * HOUR));
    await ban({ status: "lifted", liftedAt: new Date(NOW.getTime() - 30 * MIN) });
    await challenge(P, "d1", new Date(NOW.getTime() - 31 * MIN));
    expect((await tick()).banned).toEqual([]);
  });

  it("re-bans when a lift ended 61 minutes ago and the gamertag is still unlinked", async () => {
    await session(P, at(HOUR), at(3 * HOUR));
    await ban({ status: "lifted", liftedAt: new Date(NOW.getTime() - 61 * MIN) });
    await challenge(P, "d1", new Date(NOW.getTime() - 62 * MIN));
    const r = await tick();
    expect(r.banned.map((b) => b.dayzId)).toEqual([P]);
    const rows = await allBans();
    expect(rows.map((b) => b.status)).toEqual(["lifted", "pending"]);
  });

  describe("lift then link writes no new ban", () => {
    it("a lifted row and then a link: nothing written", async () => {
      await session(P, at(HOUR), at(3 * HOUR));
      await ban({ status: "lifted", liftedAt: new Date(NOW.getTime() - 2 * HOUR) });
      await link();
      const r = await tick();
      expect(r).toEqual({ banned: [], lifted: [], closed: [] });
      expect((await allBans()).map((b) => b.status)).toEqual(["lifted"]);
    });

    it("an applied ban on a linked dayz id is closed", async () => {
      await ban({ status: "applied", nitradoAdded: [P, "Unlinked"] });
      await link();
      const r = await tick();
      expect(r.closed.map((b) => b.dayzId)).toEqual([P]);
      const [row] = await allBans();
      expect(row!.status).toBe("lift_pending");
      expect(row!.nitradoAdded).toEqual([P, "Unlinked"]);   // untouched: the lift arm removes what it added
    });

    it("⚠️ a pending ban banTick already tried to apply is left alone for a linked player", async () => {
      await ban({ status: "pending", attempts: 1, nitradoAttempted: [P, "Unlinked"] });
      await link();
      expect(await tick()).toEqual({ banned: [], lifted: [], closed: [] });
      const [row] = await allBans();
      expect(row).toMatchObject({ status: "pending", attempts: 1, nitradoAdded: null });
    });

    it("⚠️ a pending ban on a linked dayz id is closed with nitrado_added = [], so the lift arm removes nothing", async () => {
      await ban({ status: "pending" });
      await link();
      const r = await tick();
      expect(r.closed.map((b) => b.dayzId)).toEqual([P]);
      const [row] = await allBans();
      expect(row!.status).toBe("lift_pending");
      expect(row!.nitradoAdded).toEqual([]);
    });
  });

  it("⚠️ never touches a zone, conduct or hub_combat ban, even linked or mid-attempt", async () => {
    for (const reason of ["zone", "conduct", "hub_combat"] as const) {
      await ban({ reason, status: "applied" });
    }
    await challenge(P, "d1", NOW);
    await link();
    expect(await tick()).toEqual({ banned: [], lifted: [], closed: [] });
    await db.delete(identityLinks);
    await db.update(identityLinkEnds).set({ endedAt: at(HOUR) });
    const r = await tick();
    // The lost link earns an unlinked ban of its own; the others stay as they were.
    expect(r.lifted).toEqual([]);
    expect(r.closed).toEqual([]);
    const rows = await allBans();
    expect(rows.filter((b) => b.reason !== "unlinked").map((b) => b.status)).toEqual(["applied", "applied", "applied"]);
  });

  it("another server's bans and sessions are not this server's", async () => {
    const [other] = await db.insert(servers).values({ name: "T", map: "nasdara", clockOffsetMs: 0, nitradoServiceId: 2, active: true }).returning();
    await db.insert(bans).values({ serverId: other!.id, dayzId: P, gamertag: "Unlinked", bannedAt: at(HOUR), status: "applied", reason: "unlinked" } as never);
    expect(await tick()).toEqual({ banned: [], lifted: [], closed: [] });
  });

  it("write: false returns the same result and writes nothing", async () => {
    await session(P, at(HOUR), at(3 * HOUR));
    const dry = await tick(NOW, false);
    expect(dry.banned.map((b) => b.dayzId)).toEqual([P]);
    expect(await allBans()).toEqual([]);

    await ban({ status: "pending" });
    await link();
    const before = await allBans();
    const dryClose = await tick(NOW, false);
    expect(dryClose.closed.map((b) => b.dayzId)).toEqual([P]);
    expect(await allBans()).toEqual(before);

    const real = await tick(NOW, true);
    expect(real).toEqual(dryClose);
  });
  it("end to end with banTick over a fake Nitrado list: ban, lift, re-ban, link, empty list", async () => {
    const list: string[] = [];
    const nitrado: BanTarget = {
      addBans: async (names) => {
        const fresh = [...new Set(names)].filter((n) => !list.includes(n));
        list.push(...fresh);
        return fresh;
      },
      removeBans: async (names) => {
        for (const n of names) { const i = list.indexOf(n); if (i >= 0) list.splice(i, 1); }
      },
    };
    const pass = async (now: Date) => {
      const g = await tick(now);
      await banTick(db, nitrado, { now, dryRun: false, since: new Date(now.getTime() - 24 * HOUR), serverId });
      return g;
    };
    const statuses = async () => (await allBans()).map((b) => b.status);

    // Unlinked play past the grace hour: banned and on the list in one pass.
    await session(P, at(HOUR), at(2 * HOUR + MIN));
    expect((await pass(NOW)).banned.map((b) => b.dayzId)).toEqual([P]);
    expect(await statuses()).toEqual(["applied"]);
    expect(list).toEqual([P, "Unlinked"]);

    // Someone starts linking it: lifted, off the list.
    await challenge(P, "d1", new Date(NOW.getTime() + 2 * MIN));
    const t1 = new Date(NOW.getTime() + 5 * MIN);
    expect((await pass(t1)).lifted.map((b) => b.dayzId)).toEqual([P]);
    expect(await statuses()).toEqual(["lifted"]);
    expect(list).toEqual([]);

    // The attempt is cancelled: banned again at once, back on the list.
    await db.update(verificationChallenges).set({ canceledAt: new Date(t1.getTime() + MIN) });
    const t2 = new Date(t1.getTime() + 5 * MIN);
    expect((await pass(t2)).banned.map((b) => b.dayzId)).toEqual([P]);
    expect(await statuses()).toEqual(["lifted", "applied"]);
    expect(list).toEqual([P, "Unlinked"]);

    // It links: the ban closes for good and the list is empty.
    await link();
    const t3 = new Date(t2.getTime() + 5 * MIN);
    expect((await pass(t3)).closed.map((b) => b.dayzId)).toEqual([P]);
    expect(await statuses()).toEqual(["lifted", "lifted"]);
    expect(list).toEqual([]);
    expect(await pass(new Date(t3.getTime() + 5 * MIN))).toEqual({ banned: [], lifted: [], closed: [] });
  });

});

describe("linkGateOpsLines", () => {
  const r = { banned: [{ dayzId: "A", gamertag: "Ay" }], lifted: [{ dayzId: "B", gamertag: "Bee" }], closed: [{ dayzId: "C", gamertag: "Cee" }] };
  it("says what was done, or what would be in dry mode", () => {
    expect(linkGateOpsLines(r, false).map((l) => l.content)).toEqual([
      "🚫 Unlinked ban queued: **Ay** (`A`) is playing without a linked account.",
      "🔓 Unlinked ban lifting: **Bee** (`B`) started linking — their one lift in 24 hours.",
      "✅ Unlinked ban closing: **Cee** (`C`) has linked.",
    ]);
    expect(linkGateOpsLines(r, true).map((l) => l.content.split(":")[0])).toEqual(["🚫 Would ban", "🔓 Would lift", "✅ Would close"]);
  });
  it("⚠️ a gamertag cannot ping or restyle the ops channel", () => {
    const [l] = linkGateOpsLines({ banned: [{ dayzId: "A", gamertag: "@everyone_*" }], lifted: [], closed: [] }, false);
    expect(l!.content).not.toContain("@everyone");
    expect(l!.content).toContain("@\u200beveryone\\_\\*");
  });
});
