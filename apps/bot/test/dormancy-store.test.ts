import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionInvites, events, admFiles, declarations, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import type { EventType } from "@factions/domain";
import { PgDormancyStore } from "../src/dormancy-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("PgDormancyStore", () => {
  let db: Database;
  let store: PgDormancyStore;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table events, raw_lines, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({
      serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true,
    }).returning();
    admFileId = f!.id;
    lineIndex = 0;
    store = new PgDormancyStore(db);
  });

  const seedFaction = async (o: Partial<{ tag: string; texture: string; poleKey: string; status: string; createdAt: Date; activatedAt: Date | null; dormantSince: Date | null; dayzId: string }> = {}) => {
    const [f] = await db.insert(factions).values({
      serverId, name: o.tag ?? "Bears", tag: o.tag ?? "BEAR",
      // Default derived from tag, not a fixed literal: tests that seed several
      // factions without overriding texture (e.g. distinct tags, default
      // status "active") would otherwise collide on factions_holding_texture_uniq.
      // "BEAR" (the default tag, whether implicit or spelled out) is the one
      // exception: it keeps the mixed-case "Flag_Bear" every raise-matching
      // test in this file already hardcodes.
      texture: o.texture ?? (o.tag === undefined || o.tag === "BEAR" ? "Flag_Bear" : `Flag_${o.tag}`),
      status: o.status ?? "active",
      leaderDiscordId: "d1", createdAt: o.createdAt ?? ago(999_999_999),
      activatedAt: o.activatedAt ?? null, dormantSince: o.dormantSince ?? null,
      reservedUntil: (o.status ?? "active") === "reserved" ? now : null,
    }).returning();

    const poleKey = o.poleKey ?? "1:2:3";
    const declaredAt = o.createdAt ?? ago(999_999_999);
    // Default "A", matching seedRaise's default dayzId — the common case is
    // one faction per test. Multi-faction tests on the same server pass a
    // distinct id to avoid faction_members_server_player_uniq.
    const dayzId = o.dayzId ?? "A";

    // Task 9's shared seed helper doesn't exist yet, so this is a minimal
    // local declaration: the faction's hold on its pole now lives in
    // `declarations` (the schema dropped factions.poleKey), and LAST_RAISE
    // joins through it. The evidence event is a real flag.raised row (every
    // declarations row needs exactly one) but deliberately keyed to a
    // pole/texture/dayzId that never matches THIS faction, so it cannot
    // itself count as the qualifying raise the tests below check for.
    const [evidence] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.raised",
      occurredAt: declaredAt,
      payload: { dayzId: "SEED-EVIDENCE", gamertag: "Seed", texture: "Flag_Seed_Evidence", poleKey: "seed:evidence:0" },
    }).returning();
    await db.insert(declarations).values({
      serverId, poleKey, x: "1.00", y: "2.00", z: "3.00",
      ownerFactionId: f!.id, evidenceEventId: evidence!.id, declaredAt,
    });

    // A roster member so the member-raise predicate has someone to match.
    // Direct inserts bypass the 200 m check, so a fixed pole key is fine here.
    await db.insert(factionMembers).values({
      factionId: f!.id, serverId, dayzId, discordId: "d1", role: "leader", joinedAt: declaredAt,
    });

    return f!;
  };

  const seedRaise = (o: { poleKey: string; texture: string; at: Date; type?: EventType; dayzId?: string }) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: o.type ?? "flag.raised",
      occurredAt: o.at,
      payload: { dayzId: o.dayzId ?? "A", gamertag: "G", texture: o.texture, poleKey: o.poleKey },
    });

  describe("clocks", () => {
    it("reports the last raise of the faction's own flag at its own pole", async () => {
      const f = await seedFaction({ poleKey: "1:2:3", texture: "Flag_Bear" });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(20_000) });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(10_000) });

      const [clock] = await store.clocks();
      expect(clock!.id).toBe(f.id);
      expect(clock!.lastRaiseAt).toEqual(ago(10_000));
    });

    it("⚠️ ignores a raise of somebody else's flag at the same pole", async () => {
      // A raider planting their own flag, or a passer-by raising a white one,
      // must not keep a dead faction's supplies alive. Deliberately stricter
      // than DayZ, which refreshes its decay timer on any raise.
      await seedFaction({ poleKey: "1:2:3", texture: "Flag_Bear", activatedAt: ago(500_000) });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_White", at: ago(10) });

      const [clock] = await store.clocks();
      expect(clock!.lastRaiseAt).toEqual(ago(500_000));
    });

    it("ignores the faction's flag raised at a different pole", async () => {
      await seedFaction({ poleKey: "1:2:3", texture: "Flag_Bear", activatedAt: ago(500_000) });
      await seedRaise({ poleKey: "9:9:9", texture: "Flag_Bear", at: ago(10) });

      const [clock] = await store.clocks();
      expect(clock!.lastRaiseAt).toEqual(ago(500_000));
    });

    it("⚠️ ignores a raise by a PENDING member", async () => {
      // A pending member has not been seen at the base yet (spec §4.5); their
      // raise must not keep a faction's supplies alive any more than a
      // stranger's would.
      await seedFaction({ poleKey: "1:2:3", texture: "Flag_Bear", activatedAt: ago(500_000) });
      await db.update(factionMembers)
        .set({ status: "pending", pendingSince: ago(500_000) })
        .where(eq(factionMembers.dayzId, "A"));
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(10) });

      const [clock] = await store.clocks();
      expect(clock!.lastRaiseAt).toEqual(ago(500_000));
    });

    it("ignores a lowering", async () => {
      await seedFaction({ poleKey: "1:2:3", texture: "Flag_Bear", activatedAt: ago(500_000) });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(10), type: "flag.lowered" });

      const [clock] = await store.clocks();
      expect(clock!.lastRaiseAt).toEqual(ago(500_000));
    });

    it("falls back to activated_at, then created_at, when no raise was ingested", async () => {
      await seedFaction({ tag: "AAA", poleKey: "1:1:1", activatedAt: ago(400), createdAt: ago(900), dayzId: "AAA" });
      await seedFaction({ tag: "BBB", poleKey: "2:2:2", activatedAt: null, createdAt: ago(800), dayzId: "BBB" });

      const clocks = await store.clocks();
      const byTag = Object.fromEntries(clocks.map((c) => [c.tag, c]));
      expect(byTag["AAA"]!.lastRaiseAt).toEqual(ago(400));
      expect(byTag["BBB"]!.lastRaiseAt).toEqual(ago(800));
    });

    it("examines only active and dormant factions", async () => {
      await seedFaction({ tag: "ACT", poleKey: "1:1:1", status: "active", dayzId: "ACT" });
      await seedFaction({ tag: "DRM", poleKey: "2:2:2", status: "dormant", dayzId: "DRM" });
      await seedFaction({ tag: "RSV", poleKey: "3:3:3", status: "reserved", dayzId: "RSV" });
      await seedFaction({ tag: "DSB", poleKey: "4:4:4", status: "disbanded", dayzId: "DSB" });

      const clocks = await store.clocks();
      expect(clocks.map((c) => c.tag).sort()).toEqual(["ACT", "DRM"]);
    });

    it("carries the leader and the name, for the DM", async () => {
      await seedFaction({ tag: "BEAR" });
      const [clock] = await store.clocks();
      expect(clock!.leaderDiscordId).toBe("d1");
      expect(clock!.name).toBe("BEAR");
      expect(clock!.dormantSince).toBeNull();
    });

    it("⚠️ reports the server's newest event, of any type — the disband liveness gate's evidence", async () => {
      // Not scoped to this faction's own pole or texture: a server-wide crash
      // loop must be visible even to a faction whose own flag was never the
      // problem. A different faction's raise on the same server counts.
      const a = await seedFaction({ tag: "AAA", poleKey: "1:1:1", dayzId: "AAA" });
      await seedFaction({ tag: "BBB", poleKey: "2:2:2", dayzId: "BBB" });
      await seedRaise({ poleKey: "2:2:2", texture: "Flag_BBB", at: ago(10) });

      const clocks = await store.clocks();
      const forA = clocks.find((c) => c.id === a.id)!;
      expect(forA.serverLastEventAt).toEqual(ago(10));
    });

    it("reports null server liveness when the server has no ingested events at all", async () => {
      // seedFaction's own declaration evidence is a real event, so a true
      // "never ingested anything" server needs a faction seeded by hand on a
      // fresh server, with no declaration and no events at all.
      const [s2] = await db.insert(servers).values({ name: "S2", map: "livonia", clockOffsetMs: 0 }).returning();
      const [f] = await db.insert(factions).values({
        serverId: s2!.id, name: "BEAR", tag: "BEAR", texture: "Flag_Bear",
        status: "active", leaderDiscordId: "d1", createdAt: ago(999_999_999),
      }).returning();
      const clocks = await store.clocks();
      const clock = clocks.find((c) => c.id === f!.id)!;
      expect(clock.serverLastEventAt).toBeNull();
    });

    it("⚠️ a non-member's raise does not wind the clock", async () => {
      const f = await seedFaction({ tag: "BEAR" });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(1000), dayzId: "STRANGER" });
      const [c] = await store.clocks();
      // No member raise at all → coalesce falls through to created_at.
      expect(c!.lastRaiseAt!.getTime()).toBe(f.createdAt.getTime());
    });

    it("a member's raise does", async () => {
      await seedFaction({ tag: "BEAR" });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(1000), dayzId: "A" });
      const [c] = await store.clocks();
      expect(c!.lastRaiseAt!.getTime()).toBe(ago(1000).getTime());
    });

    it("⚠️ takes the newest MEMBER raise, not the newest raise", async () => {
      // The mixed case is the one that matters: a stranger raising the
      // faction's flag at its own pole MORE RECENTLY than any member must not
      // wind the clock forward. A roster predicate that filtered nothing —
      // or a max() taken before the filter — passes both single-actor tests
      // above and fails only here, and the failure is silent: a dead faction
      // that a passer-by keeps flying stays "active" forever.
      await seedFaction({ tag: "BEAR" });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(1000), dayzId: "STRANGER" });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(2000), dayzId: "A" });
      const [c] = await store.clocks();
      expect(c!.lastRaiseAt!.getTime()).toBe(ago(2000).getTime());
    });
  });

  describe("transitions", () => {
    it("goes dormant and stamps the timestamp", async () => {
      const f = await seedFaction({ status: "active" });
      expect(await store.goDormant(f.id, now)).toBe(true);
      const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
      expect(row!.status).toBe("dormant");
      expect(row!.dormantSince).toEqual(now);
    });

    it("⚠️ only the transition that actually happened reports true", async () => {
      // This is what makes the DM at-most-once. A second tick that races the
      // first must not send a duplicate warning.
      const f = await seedFaction({ status: "active" });
      expect(await store.goDormant(f.id, now)).toBe(true);
      expect(await store.goDormant(f.id, now)).toBe(false);
    });

    it("refuses to make a reserved faction dormant", async () => {
      const f = await seedFaction({ status: "reserved" });
      expect(await store.goDormant(f.id, now)).toBe(false);
    });

    it("revives, clearing the timestamp", async () => {
      const f = await seedFaction({ status: "dormant", dormantSince: ago(1000) });
      expect(await store.revive(f.id)).toBe(true);
      const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
      expect(row!.status).toBe("active");
      expect(row!.dormantSince).toBeNull();
    });

    it("revives only from dormant, and only once", async () => {
      const f = await seedFaction({ status: "active" });
      expect(await store.revive(f.id)).toBe(false);
    });

    it("stamps a dormant row that has no timestamp, without touching one that has", async () => {
      const bare = await seedFaction({ tag: "AAA", poleKey: "1:1:1", status: "dormant", dormantSince: null, dayzId: "AAA" });
      const stamped = await seedFaction({ tag: "BBB", poleKey: "2:2:2", status: "dormant", dormantSince: ago(5000), dayzId: "BBB" });

      expect(await store.stampDormantSince(bare.id, now)).toBe(true);
      expect(await store.stampDormantSince(stamped.id, now)).toBe(false);

      const [a] = await db.select().from(factions).where(eq(factions.id, bare.id));
      const [b] = await db.select().from(factions).where(eq(factions.id, stamped.id));
      expect(a!.dormantSince).toEqual(now);
      expect(b!.dormantSince).toEqual(ago(5000));
    });

    it("pauses a dormant row that HAS a timestamp, without touching one that has none", async () => {
      // ⚠️ The exact complement of the stamp test above, and the pair is the
      // point: stamp owns `dormant_since IS NULL` and pause owns IS NOT NULL,
      // so neither can act on the other's row. If both guards ever matched the
      // same row, a mis-routed transition would silently double-write.
      const bare = await seedFaction({ tag: "CCC", poleKey: "3:3:3", status: "dormant", dormantSince: null, dayzId: "CCC" });
      const running = await seedFaction({ tag: "DDD", poleKey: "4:4:4", status: "dormant", dormantSince: ago(5000), dayzId: "DDD" });

      expect(await store.pauseDormancyClock(bare.id, now)).toBe(false);
      expect(await store.pauseDormancyClock(running.id, now)).toBe(true);

      const [a] = await db.select().from(factions).where(eq(factions.id, bare.id));
      const [b] = await db.select().from(factions).where(eq(factions.id, running.id));
      expect(a!.dormantSince).toBeNull();
      expect(b!.dormantSince).toEqual(now);
    });

    it("pauses only a dormant faction, never an active one", async () => {
      // An active faction has no countdown to restart, and writing
      // dormant_since onto one would hand the next tick a row whose status and
      // timestamp disagree.
      const f = await seedFaction({ status: "active" });
      expect(await store.pauseDormancyClock(f.id, now)).toBe(false);
      const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
      expect(row!.dormantSince).toBeNull();
    });

    it("⚠️ a paused row is no longer disbandable at the old cutoff", async () => {
      // The behaviour the whole change exists for, at the storage layer: the
      // row was due, the pause moved its clock, and the same cutoff that would
      // have disbanded it now refuses.
      const f = await seedFaction({ status: "dormant", dormantSince: ago(2000) });
      expect(await store.pauseDormancyClock(f.id, now)).toBe(true);
      expect(await store.disbandDormant(f.id, ago(1000))).toBe(false);
      const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
      expect(row!.status).toBe("dormant");
    });

    it("disbands a faction dormant past the window", async () => {
      const f = await seedFaction({ status: "dormant", dormantSince: ago(2000) });
      expect(await store.disbandDormant(f.id, ago(1000))).toBe(true);
      const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
      expect(row!.status).toBe("disbanded");
    });

    it("does not disband one that is not yet due", async () => {
      const f = await seedFaction({ status: "dormant", dormantSince: ago(500) });
      expect(await store.disbandDormant(f.id, ago(1000))).toBe(false);
      // The operation destroys player property with no undo — a false return
      // that still wrote would be worse than useless.
      const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
      expect(row!.status).toBe("dormant");
    });

    it("⚠️ never disbands a dormant faction with no dormant_since", async () => {
      // decide() returns "stamp" for this, but the store must refuse it too:
      // a NULL comparison silently matching would release a flag on no evidence.
      const f = await seedFaction({ status: "dormant", dormantSince: null });
      expect(await store.disbandDormant(f.id, ago(1000))).toBe(false);
      const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
      expect(row!.status).toBe("dormant");
      expect(row!.dormantSince).toBeNull();
    });

    it("refuses an active faction whatever the cutoff", async () => {
      const f = await seedFaction({ status: "active", dormantSince: ago(999_999) });
      expect(await store.disbandDormant(f.id, now)).toBe(false);
      const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
      expect(row!.status).toBe("active");
    });

    it("⚠️ disbands exactly at the cutoff, matching decide()'s >= boundary", async () => {
      // decide() treats a row exactly `disbandAfterDormantMs` old as due
      // ("`>=`"). This store call is what dormancyTick actually makes with
      // `dormantBefore = now - disbandAfterDormantMs`, so the guard here must
      // agree at the exact boundary or a row due by decide()'s reckoning sits
      // for one extra tick before disbanding anyway.
      const cutoff = ago(1000);
      const f = await seedFaction({ status: "dormant", dormantSince: cutoff });
      expect(await store.disbandDormant(f.id, cutoff)).toBe(true);
      const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
      expect(row!.status).toBe("disbanded");
    });

    it("⚠️ clears the roster and revokes invites, exactly as /faction disband does", async () => {
      // A status write alone leaves membership rows pointing at a disbanded
      // faction. They are invisible to their owners — the membership lookup
      // filters on HOLDING_STATUSES — but still collide with
      // faction_members_server_player_uniq if those players join another faction
      // on the same server.
      //
      // seedFaction already seeds the leader row this test needs (dayzId
      // "A"); a second explicit insert here would collide with it on
      // faction_members_leader_uniq, one leader per faction.
      const f = await seedFaction({ status: "dormant", dormantSince: ago(2000) });
      await db.insert(factionInvites).values({
        factionId: f.id, serverId, invitedByDiscordId: "d1", inviteeDiscordId: "d2",
        inviteeDayzId: "B".repeat(40), createdAt: now, expiresAt: new Date(now.getTime() + 1000),
      });

      expect(await store.disbandDormant(f.id, ago(1000))).toBe(true);

      expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, f.id))).toHaveLength(0);
      const [invite] = await db.select().from(factionInvites).where(eq(factionInvites.factionId, f.id));
      expect(invite!.revokedAt).not.toBeNull();
    });
  });
});
