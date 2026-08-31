import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, identityLinks, factions, factionMembers, type Database } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { sql, eq } from "drizzle-orm";
import { PgCeremonyStore } from "../src/ceremony-store.js";
import { ceremonyTick } from "../src/ceremony-tick.js";

const URL = requireTestDatabaseUrl();
const MEMBER = "A".repeat(40);
const STRANGER = "Z".repeat(40);
const POLE = "1:2:3";
const T0 = new Date("2026-08-31T12:00:00Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);

describe("activation and lapse", () => {
  let db: Database;
  let store: PgCeremonyStore;
  let serverId = 0;
  let admFileId = 0;
  let factionId = 0;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table ceremony_participants, ceremonies, white_raises, faction_members, claim_drafts, factions, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    store = new PgCeremonyStore(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: T0 }).returning();
    admFileId = f!.id;
    line = 0;
    await db.insert(identityLinks).values({ discordId: "100", dayzId: MEMBER, gamertag: "Steve", verifiedAt: T0 });
    const [fac] = await db.insert(factions).values({
      serverId, name: "The Bears", tag: "BEAR", texture: "Flag_Bear", poleKey: POLE,
      x: "1.00", y: "2.00", z: "3.00", status: "reserved", leaderDiscordId: "100",
      createdAt: T0, reservedUntil: new Date(T0.getTime() + 86_400_000),
    }).returning();
    factionId = fac!.id;
    await db.insert(factionMembers).values({ factionId, dayzId: MEMBER, discordId: "100", role: "leader", joinedAt: T0 });
  });

  const raise = (dayzId: string, minutes: number, texture: string, poleKey = POLE) =>
    appendEvent(db, {
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "flag.raised", occurredAt: at(minutes),
      payload: { gamertag: "Steve", dayzId, texture, action: "raised", poleKey, pole: { x: 1, y: 2, z: 3 } },
    });

  const tick = (now = at(30)) => ceremonyTick(db, store, { batchSize: 100, now });
  const status = async () => (await db.select().from(factions).where(eq(factions.id, factionId)))[0]?.status;

  it("activates when a roster member raises the faction's flag at its pole", async () => {
    await raise(MEMBER, 1, "Flag_Bear");
    expect((await tick()).activated).toBe(1);
    expect(await status()).toBe("active");
    const [f] = await db.select().from(factions);
    expect(f?.activatedAt).toEqual(at(1));
  });

  it("does not activate for a UID off the roster", async () => {
    // The log must prove a roster member was physically at the pole.
    await raise(STRANGER, 1, "Flag_Bear");
    expect((await tick()).activated).toBe(0);
    expect(await status()).toBe("reserved");
  });

  it("does not activate on the wrong texture", async () => {
    await raise(MEMBER, 1, "Flag_Wolf");
    expect(await status()).toBe("reserved");
  });

  it("does not activate at the wrong pole", async () => {
    await raise(MEMBER, 1, "Flag_Bear", "9:9:9");
    await tick();
    expect(await status()).toBe("reserved");
  });

  it("activates only once", async () => {
    await raise(MEMBER, 1, "Flag_Bear");
    await tick();
    await raise(MEMBER, 2, "Flag_Bear");
    expect((await tick()).activated).toBe(0);
    expect(await status()).toBe("active");
  });

  it("lapses a reservation once both clocks pass the deadline", async () => {
    await raise(MEMBER, 60 * 48, "Flag_Wolf"); // log advances two days
    expect((await tick(at(60 * 48))).lapsed).toBe(1);
    expect(await status()).toBe("lapsed");
  });

  it("does not lapse while the log is behind the deadline", async () => {
    // ⚠️ The whole point of the two-clock rule: if ingest stalls, a faction
    // that DID raise its flag would otherwise be retired because the proof was
    // never ingested.
    await raise(MEMBER, 1, "Flag_Wolf");
    expect((await tick(new Date(T0.getTime() + 48 * 3_600_000))).lapsed).toBe(0);
    expect(await status()).toBe("reserved");
  });

  it("frees the flag when a reservation lapses", async () => {
    await raise(MEMBER, 60 * 48, "Flag_Wolf");
    await tick(at(60 * 48));
    await expect(db.insert(factions).values({
      serverId, name: "Other", tag: "OTH", texture: "Flag_Bear", poleKey: "9:9:9",
      x: "1.00", y: "2.00", z: "3.00", status: "reserved", leaderDiscordId: "900",
      createdAt: T0, reservedUntil: new Date(T0.getTime() + 86_400_000),
    })).resolves.toBeDefined();
  });
});
