import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, servers, flagHolds, factions, ceremonies, ceremonyParticipants,
  identityLinks, players, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { CLAIMABLE_FLAGS, HOLDING_STATUSES } from "@factions/domain";
import { flagTakenTx, freeFlagsDb } from "../src/internal/flag-holds";
import { claimCeremonyDb } from "../src/writes";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-10-13T12:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const UID_L = "L".repeat(40);

describe("flag holds: the free pool", () => {
  let db: Database;
  let serverId = 0;
  let bear = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table flag_holds, faction_textures, faction_members, declarations, poles, ceremony_participants, ceremonies, claim_drafts, identity_links, players, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: now, activatedAt: now })).id;
  });

  it("a holding clan's flag is taken", async () => {
    expect(await flagTakenTx(db, serverId, "Flag_Bear", now)).toBe(true);
    expect(await flagTakenTx(db, serverId, "Flag_Wolf", now)).toBe(false);
  });

  // ⚠️ The pool's two reads must follow HOLDING_STATUSES, the same set the
  // `factions_holding_texture_uniq` predicate spells (pinned against it by
  // packages/db/test/holding-index-drift.test.ts, which cannot import roster).
  it.each(["reserved", "active", "dormant", "lapsed", "disbanded"] as const)("a %s clan holds its flag iff its status is a holding one", async (status) => {
    await db.update(factions).set({ status, reservedUntil: status === "reserved" ? later(86_400_000) : null }).where(eq(factions.id, bear));
    const holds = (HOLDING_STATUSES as readonly string[]).includes(status);
    expect(await flagTakenTx(db, serverId, "Flag_Bear", now)).toBe(holds);
    expect((await freeFlagsDb(db, serverId, now)).includes("Flag_Bear")).toBe(!holds);
  });

  it("a pending hold is taken even past its deadline, until the sweep deletes it", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: now, createdAt: now });
    expect(await flagTakenTx(db, serverId, "Flag_Wolf", later(3_600_000))).toBe(true);
  });

  it("a released hold is taken only until it expires", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Rex", factionId: bear, kind: "released", until: later(1000), createdAt: now });
    expect(await flagTakenTx(db, serverId, "Flag_Rex", now)).toBe(true);
    expect(await flagTakenTx(db, serverId, "Flag_Rex", later(1000))).toBe(false);
  });

  it("freeFlagsDb excludes holding clans and live holds, in pool order", async () => {
    await db.insert(flagHolds).values([
      { serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: now, createdAt: now },
      { serverId, texture: "Flag_Rex", factionId: bear, kind: "released", until: now, createdAt: now }, // already expired
    ]);
    const free = await freeFlagsDb(db, serverId, now);
    expect(free).not.toContain("Flag_Bear");
    expect(free).not.toContain("Flag_Wolf");
    expect(free).toContain("Flag_Rex");
    expect(free).toEqual(CLAIMABLE_FLAGS.filter((f) => free.includes(f)));
  });

  it("founding refuses a flag a rival's pending rebrand holds", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: later(86_400_000), createdAt: now });
    await db.insert(players).values({ dayzId: UID_L, gamertag: "Leo", firstSeenAt: now, lastSeenAt: now });
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: UID_L, gamertag: "Leo", verifiedAt: now });
    const [c] = await db.insert(ceremonies).values({
      serverId, poleKey: "8000.00:100.00:8000.00", x: "8000.00", y: "100.00", z: "8000.00",
      windowStart: now, windowEnd: now, status: "provisional", detectedAt: now, expiresAt: later(86_400_000),
    }).returning({ id: ceremonies.id });
    await db.insert(ceremonyParticipants).values({ ceremonyId: c!.id, dayzId: UID_L, discordId: "d1", gamertag: "Leo" });
    const out = await claimCeremonyDb(db, now, "d1", c!.id, {
      name: "Wolves", tag: "WOLF", texture: "Flag_Wolf", memberDayzIds: [UID_L],
    });
    expect(out).toBe("flag-taken");
    expect(await db.select().from(factions).where(eq(factions.tag, "WOLF"))).toHaveLength(0);
  });
});
