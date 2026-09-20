import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, players, boosterKits, boosterKitChallenges, discordBoosters,
  type Database,
} from "@factions/db";
import { KIT_PLACEMENT_TTL_MS, LINK_EMOTES, KIT_SLOTS, type KitSlot } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { boosterKitForDb, cancelKitPlacementDb, saveBoosterKitSlotDb, saveBoosterKitDb, startKitPlacementDb } from "../src/booster-kit";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-19T12:00:00Z");
const UID = "A".repeat(40);

describe("the booster kit page's reads and writes", () => {
  let db: Database; let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table booster_kit_challenges, booster_kits, discord_boosters, declarations, poles, faction_members, factions, identity_links, players, events, raw_lines, adm_files, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(players).values({ dayzId: UID, gamertag: "Ronald", firstSeenAt: now, lastSeenAt: now });
  });

  const link = () => db.insert(identityLinks).values({ discordId: "1", dayzId: UID, gamertag: "Ronald", verifiedAt: now });
  const boost = () => db.insert(discordBoosters).values({ discordId: "1", premiumSince: now, observedAt: now });
  const save = (slot: string, className: string) =>
    saveBoosterKitSlotDb(db, { discordId: "1", slot, className, now });

  // Every slot picked something real, so a test can flip exactly one slot to
  // a refused value and still have every other slot be a valid pick.
  const ALL_PICKS: Record<KitSlot, string> = {
    mask: "BalaclavaMask_BDU", eyewear: "SportGlasses_Black", hat: "ChristmasHeadband_Antlers",
    jacket: "BDUJacket", pants: "BDUPants", boots: "MilitaryBoots_Beige",
    gloves: "OMNOGloves_Brown", hipPack: "HipPack_Black", backpack: "TortillaBag",
  };
  const saveAll = (picks: Record<KitSlot, string> = ALL_PICKS) =>
    saveBoosterKitDb(db, { discordId: "1", picks, now });

  describe("saveBoosterKitSlotDb", () => {
    it("rejects a class name outside the catalogue for that slot", async () => {
      expect(await save("mask", "GorkaEJacket_Summer")).toEqual({ ok: false, reason: "bad-pick" });
      expect(await db.select().from(boosterKits)).toEqual([]);
    });

    it("rejects a slot that is not one of the nine", async () => {
      expect(await save("armband", "Armband_Zenit")).toEqual({ ok: false, reason: "bad-slot" });
      expect(await db.select().from(boosterKits)).toEqual([]);
    });

    it("accepting reports ok, so the page can tell a save from a refusal", async () => {
      expect(await save("mask", "HockeyMask")).toEqual({ ok: true });
    });

    /**
     * ⚠️ The distinction the page depends on. A refused pick is an answer for
     * the player; a dead database is an outage. If a failed write came back as
     * `ok: false` the site would tell a booster their perfectly valid jacket
     * "is not on the list", they would re-pick from that same list forever,
     * and nobody would ever report the outage.
     */
    it("lets an unexpected write failure propagate instead of reporting a bad pick", async () => {
      const broken = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "insert") return () => { throw new Error("connection terminated"); };
          return Reflect.get(target, prop, receiver);
        },
      }) as Database;
      await expect(saveBoosterKitSlotDb(broken, { discordId: "1", slot: "mask", className: "HockeyMask", now }))
        .rejects.toThrow("connection terminated");
    });

    it("accepts an allowed class name and leaves the position untouched", async () => {
      // ⚠️ The spec's §2.6, and the reason this suite exists: editing gear
      // must never disturb a spot the player already marked in game.
      await db.insert(boosterKits).values({
        discordId: "1", posX: "1.00", posY: "2.00", posZ: "3.00", placedAt: now, updatedAt: now,
      });
      await save("mask", "HockeyMask");
      const [row] = await db.select().from(boosterKits);
      expect(row!.mask).toBe("HockeyMask");
      expect(Number(row!.posX)).toBe(1);
      expect(Number(row!.posY)).toBe(2);
      expect(Number(row!.posZ)).toBe(3);
      expect(row!.placedAt).toEqual(now);
    });

    it("creates the row for a booster who has picked nothing yet", async () => {
      await save("backpack", "TortillaBag");
      const [row] = await db.select().from(boosterKits);
      expect(row!.backpack).toBe("TortillaBag");
      expect(row!.posX).toBeNull();
    });

    it("clears a slot when given an empty class name, and touches no other slot", async () => {
      await save("mask", "HockeyMask");
      await save("jacket", "BDUJacket");
      await save("mask", "");
      const [row] = await db.select().from(boosterKits);
      expect(row!.mask).toBeNull();
      expect(row!.jacket).toBe("BDUJacket");
    });
  });

  describe("saveBoosterKitDb", () => {
    it("writes all nine slots in one call", async () => {
      expect(await saveAll()).toEqual({ ok: true });
      const [row] = await db.select().from(boosterKits);
      for (const slot of KIT_SLOTS) expect([slot, row![slot]]).toEqual([slot, ALL_PICKS[slot]]);
    });

    /**
     * ⚠️ The whole point of validating every pick BEFORE writing any of them.
     * Nine single-slot saves in a loop would let the first few land while a
     * later one refused, leaving the row half updated with no way to say
     * which half. One bad pick anywhere must leave the table exactly as it
     * was, not partially saved.
     */
    it("refuses the whole kit on the first bad pick, and writes nothing", async () => {
      const picks = { ...ALL_PICKS, jacket: "NotARealJacket" };
      expect(await saveAll(picks)).toEqual({ ok: false, reason: "bad-pick" });
      expect(await db.select().from(boosterKits)).toEqual([]);
    });

    it("refuses on a bad pick even when it already has a saved kit, and leaves the saved kit untouched", async () => {
      await saveAll();
      const picks = { ...ALL_PICKS, mask: "not-a-real-item" };
      expect(await saveAll(picks)).toEqual({ ok: false, reason: "bad-pick" });
      const [row] = await db.select().from(boosterKits);
      expect(row!.mask).toBe(ALL_PICKS.mask);
    });

    it("clears every slot given empty class names, and touches no other column", async () => {
      await saveAll();
      const cleared = Object.fromEntries(KIT_SLOTS.map((s) => [s, ""])) as Record<KitSlot, string>;
      expect(await saveAll(cleared)).toEqual({ ok: true });
      const [row] = await db.select().from(boosterKits);
      for (const slot of KIT_SLOTS) expect([slot, row![slot]]).toEqual([slot, null]);
    });

    it("leaves the placed position untouched, same as the single-slot save", async () => {
      // ⚠️ Same reason as saveBoosterKitSlotDb: gear and position are
      // separate concerns, and a bulk write that spelled out the whole row
      // would reset a spot the player already marked in game.
      await db.insert(boosterKits).values({
        discordId: "1", posX: "1.00", posY: "2.00", posZ: "3.00", placedAt: now, updatedAt: now,
      });
      await saveAll();
      const [row] = await db.select().from(boosterKits);
      expect(Number(row!.posX)).toBe(1);
      expect(Number(row!.posY)).toBe(2);
      expect(Number(row!.posZ)).toBe(3);
      expect(row!.placedAt).toEqual(now);
      expect(row!.mask).toBe(ALL_PICKS.mask);
    });

    it("lets an unexpected write failure propagate instead of reporting a bad pick", async () => {
      // Same distinction as the single-slot save: an outage must surface as
      // a real error, never as "that item is not on the list".
      const broken = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "insert") return () => { throw new Error("connection terminated"); };
          return Reflect.get(target, prop, receiver);
        },
      }) as Database;
      await expect(saveBoosterKitDb(broken, { discordId: "1", picks: ALL_PICKS, now }))
        .rejects.toThrow("connection terminated");
    });
  });

  describe("boosterKitForDb", () => {
    it("reports not boosting, not linked, for a stranger", async () => {
      const view = await boosterKitForDb(db, "1", now);
      expect(view.boosting).toBe(false);
      expect(view.linked).toBeNull();
      expect(view.spot).toBeNull();
      expect(view.armband).toBeNull();
    });

    it("reports boosting without a link", async () => {
      await boost();
      const view = await boosterKitForDb(db, "1", now);
      expect(view.boosting).toBe(true);
      expect(view.linked).toBeNull();
    });

    it("returns the nine slots, the spot, and the clan's armband derived from its flag", async () => {
      await boost();
      await link();
      const [f] = await db.insert(factions).values({
        serverId, name: "Zenit", tag: "ZEN", texture: "Flag_Zenit", status: "active",
        leaderDiscordId: "1", createdAt: now,
      }).returning();
      await db.insert(factionMembers).values({
        serverId, factionId: f!.id, dayzId: UID, discordId: "1", role: "leader", status: "full", joinedAt: now,
      });
      await db.insert(boosterKits).values({
        discordId: "1", mask: "HockeyMask", posX: "10.00", posY: "20.00", posZ: "30.00", placedAt: now, updatedAt: now,
      });
      const view = await boosterKitForDb(db, "1", now);
      expect(view.linked?.gamertag).toBe("Ronald");
      expect(view.slots.mask).toBe("HockeyMask");
      expect(view.slots.jacket).toBeNull();
      expect(view.spot).toEqual({ x: 10, y: 20, z: 30, placedAt: now });
      expect(view.armband).toEqual({ className: "Armband_Zenit", texture: "Flag_Zenit", clanName: "Zenit", clanTag: "ZEN" });
    });

    it("shows an open placement challenge and hides an expired one", async () => {
      await link();
      await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random });
      expect((await boosterKitForDb(db, "1", now)).challenge?.steps).toHaveLength(LINK_EMOTES);
      const later = new Date(now.getTime() + KIT_PLACEMENT_TTL_MS + 1);
      expect((await boosterKitForDb(db, "1", later)).challenge).toBeNull();
    });

    /**
     * ⚠️ The count the page prints is the SERVER's, read straight off
     * `progress_index`. The page says "the server has confirmed N of 3" in as
     * many words, and a count derived from anything else would be a claim the
     * server never made.
     */
    it("marks the steps the server has already witnessed, and counts them", async () => {
      await link();
      const issued = await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random });
      expect(issued!.confirmed).toBe(0);
      expect(issued!.steps.every((s) => !s.confirmed)).toBe(true);

      await db.update(boosterKitChallenges).set({ progressIndex: 2 })
        .where(eq(boosterKitChallenges.id, issued!.id));

      const { challenge } = await boosterKitForDb(db, "1", now);
      expect(challenge!.id).toBe(issued!.id);
      expect(challenge!.confirmed).toBe(2);
      expect(challenge!.steps.map((s) => s.confirmed)).toEqual([true, true, false]);
    });
  });

  describe("cancelKitPlacementDb", () => {
    it("closes the open sequence, and the page stops showing one", async () => {
      await link();
      await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random });
      expect(await cancelKitPlacementDb(db, { discordId: "1", now })).toBe(true);
      expect((await boosterKitForDb(db, "1", now)).challenge).toBeNull();
      const rows = await db.select().from(boosterKitChallenges).where(eq(boosterKitChallenges.discordId, "1"));
      expect(rows.filter((r) => r.closedAt === null)).toHaveLength(0);
    });

    /**
     * ⚠️ The only way to reach this is the Cancel button on an open sequence,
     * so "there was nothing open" only ever happens when the sequence ended
     * between the render and the tap. It is not an error.
     */
    it("is safe to call with nothing open", async () => {
      expect(await cancelKitPlacementDb(db, { discordId: "1", now })).toBe(false);
    });

    /**
     * ⚠️ Cancelling a sequence must not clear a spot already marked. The
     * challenge row and the kit row are separate writes for this reason.
     */
    it("leaves a spot already marked exactly where it is", async () => {
      await link();
      await db.insert(boosterKits).values({
        discordId: "1", mask: "HockeyMask", posX: "1.00", posY: "2.00", posZ: "3.00", placedAt: now, updatedAt: now,
      });
      await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random });
      await cancelKitPlacementDb(db, { discordId: "1", now });
      const view = await boosterKitForDb(db, "1", now);
      expect(view.spot).toEqual({ x: 1, y: 2, z: 3, placedAt: now });
      expect(view.slots.mask).toBe("HockeyMask");
    });

    /** ⚠️ Scoped to the caller. Nobody else's sequence is reachable from here. */
    it("closes nobody else's sequence", async () => {
      await link();
      await db.insert(identityLinks).values({ discordId: "2", dayzId: "B".repeat(40), gamertag: "Other", verifiedAt: now });
      await db.insert(players).values({ dayzId: "B".repeat(40), gamertag: "Other", firstSeenAt: now, lastSeenAt: now });
      await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random });
      await startKitPlacementDb(db, { discordId: "2", now, rng: Math.random });
      await cancelKitPlacementDb(db, { discordId: "1", now });
      expect((await boosterKitForDb(db, "2", now)).challenge).not.toBeNull();
    });
  });

  describe("startKitPlacementDb", () => {
    it("refuses an account with no linked character", async () => {
      expect(await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random })).toBeNull();
    });

    it("issues a labelled sequence that expires after KIT_PLACEMENT_TTL_MS", async () => {
      await link();
      const out = await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random });
      expect(out!.steps).toHaveLength(LINK_EMOTES);
      for (const s of out!.steps) expect(s.label.length).toBeGreaterThan(0);
      expect(out!.expiresAt.getTime()).toBe(now.getTime() + KIT_PLACEMENT_TTL_MS);
    });

    it("never writes a position — drawing a new sequence leaves the current spot alone", async () => {
      await link();
      await db.insert(boosterKits).values({
        discordId: "1", mask: "HockeyMask", posX: "1.00", posY: "2.00", posZ: "3.00", placedAt: now, updatedAt: now,
      });
      await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random });
      const [row] = await db.select().from(boosterKits);
      expect(Number(row!.posX)).toBe(1);
      expect(row!.placedAt).toEqual(now);
      // The row-creating insert must be onConflictDoNothing, not an upsert:
      // an existing kit's gear is not the placement flow's to touch.
      expect(row!.mask).toBe("HockeyMask");
    });

    /**
     * ⚠️ The whole point of creating the row here. Nothing but a slot save
     * used to create `booster_kits`, so a booster who drew the sequence
     * before picking any gear and then performed it in game hit
     * `kitPlacementTick`'s `missing-kit` branch: the challenge closed, the
     * witnessed position was discarded, and the page still said "No spot
     * yet" with no copy explaining why. They could repeat it forever.
     */
    it("creates the kit row, so a sequence drawn before any gear is picked has something to move", async () => {
      await link();
      await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random });
      const [row] = await db.select().from(boosterKits);
      expect(row!.discordId).toBe("1");
      // Empty in every other respect: no gear, and no spot until the emotes
      // are witnessed. An all-null kit spawns nothing (booster-kit-tick.ts).
      expect(row!.mask).toBeNull();
      expect(row!.posX).toBeNull();
      expect(row!.placedAt).toBeNull();
    });

    it("closes the previous open challenge rather than leaving two", async () => {
      await link();
      await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random });
      await startKitPlacementDb(db, { discordId: "1", now, rng: Math.random });
      const rows = await db.select().from(boosterKitChallenges).where(eq(boosterKitChallenges.discordId, "1"));
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.closedAt === null)).toHaveLength(1);
    });
  });
});
