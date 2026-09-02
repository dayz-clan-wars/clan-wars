import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, events, admFiles, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import type { EventType } from "@factions/domain";
import { PgDormancyStore } from "../src/dormancy-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("PgDormancyStore", () => {
  describe("clocks", () => {
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
});
