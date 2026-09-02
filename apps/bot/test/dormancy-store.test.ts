import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionInvites, events, admFiles, type Database,
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

  const seedFaction = async (o: Partial<{ tag: string; texture: string; poleKey: string; status: string; createdAt: Date; activatedAt: Date | null; dormantSince: Date | null }> = {}) => {
    const [f] = await db.insert(factions).values({
      serverId, name: o.tag ?? "Bears", tag: o.tag ?? "BEAR",
      // Default derived from tag, not a fixed literal: tests that seed several
      // factions without overriding texture (e.g. distinct tags, default
      // status "active") would otherwise collide on factions_holding_texture_uniq.
      texture: o.texture ?? `Flag_${o.tag ?? "Bear"}`, poleKey: o.poleKey ?? "1:2:3",
      x: "1", y: "2", z: "3", status: o.status ?? "active",
      leaderDiscordId: "d1", createdAt: o.createdAt ?? ago(999_999_999),
      activatedAt: o.activatedAt ?? null, dormantSince: o.dormantSince ?? null,
      reservedUntil: (o.status ?? "active") === "reserved" ? now : null,
    }).returning();
    return f!;
  };

  const seedRaise = (o: { poleKey: string; texture: string; at: Date; type?: EventType }) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: o.type ?? "flag.raised",
      occurredAt: o.at,
      payload: { dayzId: "A", gamertag: "G", texture: o.texture, poleKey: o.poleKey },
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

    it("ignores a lowering", async () => {
      await seedFaction({ poleKey: "1:2:3", texture: "Flag_Bear", activatedAt: ago(500_000) });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(10), type: "flag.lowered" });

      const [clock] = await store.clocks();
      expect(clock!.lastRaiseAt).toEqual(ago(500_000));
    });

    it("falls back to activated_at, then created_at, when no raise was ingested", async () => {
      await seedFaction({ tag: "AAA", poleKey: "1:1:1", activatedAt: ago(400), createdAt: ago(900) });
      await seedFaction({ tag: "BBB", poleKey: "2:2:2", activatedAt: null, createdAt: ago(800) });

      const clocks = await store.clocks();
      const byTag = Object.fromEntries(clocks.map((c) => [c.tag, c]));
      expect(byTag["AAA"]!.lastRaiseAt).toEqual(ago(400));
      expect(byTag["BBB"]!.lastRaiseAt).toEqual(ago(800));
    });

    it("examines only active and dormant factions", async () => {
      await seedFaction({ tag: "ACT", poleKey: "1:1:1", status: "active" });
      await seedFaction({ tag: "DRM", poleKey: "2:2:2", status: "dormant" });
      await seedFaction({ tag: "RSV", poleKey: "3:3:3", status: "reserved" });
      await seedFaction({ tag: "DSB", poleKey: "4:4:4", status: "disbanded" });

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
      const bare = await seedFaction({ tag: "AAA", poleKey: "1:1:1", status: "dormant", dormantSince: null });
      const stamped = await seedFaction({ tag: "BBB", poleKey: "2:2:2", status: "dormant", dormantSince: ago(5000) });

      expect(await store.stampDormantSince(bare.id, now)).toBe(true);
      expect(await store.stampDormantSince(stamped.id, now)).toBe(false);

      const [a] = await db.select().from(factions).where(eq(factions.id, bare.id));
      const [b] = await db.select().from(factions).where(eq(factions.id, stamped.id));
      expect(a!.dormantSince).toEqual(now);
      expect(b!.dormantSince).toEqual(ago(5000));
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
    });

    it("⚠️ never disbands a dormant faction with no dormant_since", async () => {
      // decide() returns "stamp" for this, but the store must refuse it too:
      // a NULL comparison silently matching would release a flag on no evidence.
      const f = await seedFaction({ status: "dormant", dormantSince: null });
      expect(await store.disbandDormant(f.id, ago(1000))).toBe(false);
    });

    it("refuses an active faction whatever the cutoff", async () => {
      const f = await seedFaction({ status: "active", dormantSince: ago(999_999) });
      expect(await store.disbandDormant(f.id, now)).toBe(false);
    });

    it("⚠️ clears the roster and revokes invites, exactly as /faction disband does", async () => {
      // A status write alone leaves membership rows pointing at a disbanded
      // faction. They are invisible to their owners — the membership lookup
      // filters on HOLDING_STATUSES — but still collide with
      // faction_members_server_player_uniq if those players join another faction
      // on the same server.
      const f = await seedFaction({ status: "dormant", dormantSince: ago(2000) });
      await db.insert(factionMembers).values({
        factionId: f.id, serverId, discordId: "d1", dayzId: "A".repeat(40), role: "leader", joinedAt: now,
      });
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
