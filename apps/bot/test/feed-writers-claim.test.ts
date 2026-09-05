import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, admFiles, events as eventRows, factionEvents, factions, servers, ceremonies, identityLinks, players, type Database } from "@factions/db";
import { asc, sql } from "drizzle-orm";
import { PgFactionStore } from "../src/faction-store.js";
import { PgCeremonyStore } from "../src/ceremony-store.js";
import { declareSolo, declarationForPlayer } from "@factions/declarations";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");

describe("claim path writes feed events", () => {
  let db: Database;
  let serverId = 0;
  let ceremonyId = 0;
  let secondCeremonyId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_events, ceremony_participants, ceremonies, players, identity_links, faction_members, claim_drafts, factions, servers restart identity cascade`);
    });

    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;

    // A linked player: identity_links carries the verification-time
    // gamertag, players carries the current one. actorGamertagTx prefers the
    // latter, so both rows share the same value here — "Racer" — to match
    // the brief's assertions.
    await db.insert(identityLinks).values({
      discordId: "d1", dayzId: "u1", gamertag: "Racer", verifiedAt: now,
    });
    await db.insert(players).values({
      dayzId: "u1", gamertag: "Racer", firstSeenAt: now, lastSeenAt: now,
    });

    // Two provisional ceremonies at different poles, so the tag-collision
    // test has a second ceremony to claim against.
    const [c1] = await db.insert(ceremonies).values({
      serverId, poleKey: "1:2:3", x: "1", y: "2", z: "3",
      windowStart: now, windowEnd: now, status: "provisional",
      detectedAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
    }).returning({ id: ceremonies.id });
    ceremonyId = c1!.id;

    const [c2] = await db.insert(ceremonies).values({
      serverId, poleKey: "4:5:6", x: "4", y: "5", z: "6",
      windowStart: now, windowEnd: now, status: "provisional",
      detectedAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
    }).returning({ id: ceremonies.id });
    secondCeremonyId = c2!.id;
  });

  const events = () => db.select().from(factionEvents).orderBy(asc(factionEvents.id));

  // Well clear of HUB_POSITION (100, 93): declareTx checks the Hub
  // unconditionally (spec §4.10), so a pole near the origin would fail every
  // reserve with "too-close" before these tests reach the scarcity rule they
  // mean to exercise.
  /** ceremonyId comes from the fixture; everything else is fixed here. */
  const args = (ceremonyId: number, over: Partial<{ tag: string; texture: string; poleKey: string }> = {}) => ({
    ceremonyId, serverId,
    poleKey: over.poleKey ?? "10000:2:10000", x: "10000", y: "2", z: "10000",
    name: "Bears", tag: over.tag ?? "BEAR", texture: over.texture ?? "Flag_Bear",
    leaderDiscordId: "d1",
    members: [{ dayzId: "u1", discordId: "d1" }],
    at: now, reservedUntil: new Date(now.getTime() + 86_400_000),
  });

  it("⚠️ writes founded in the SAME transaction as the reservation", async () => {
    // A separate write means a crash between the two leaves a transition
    // that will never be announced, and nothing reconciles the two.
    expect(await new PgFactionStore(db).reserve(args(ceremonyId))).toBe("ok");

    const [e] = await events();
    expect(e!.kind).toBe("founded");
    expect(e!.payload).toMatchObject({ name: "Bears", tag: "BEAR", texture: "Flag_Bear", actor: "Racer" });
    expect(e!.occurredAt).toEqual(now);
  });

  it("writes no founded row when the reservation loses a race", async () => {
    // The ceremony is retired with `status = 'provisional'` in the WHERE
    // clause, so the second claim against it finds nothing to retire.
    const store = new PgFactionStore(db);
    await store.reserve(args(ceremonyId));
    expect(await store.reserve(args(ceremonyId))).toBe("ceremony-taken");
    expect(await events()).toHaveLength(1);
  });

  it("writes no founded row when a unique index rejects the claim", async () => {
    // A tag collision throws out of the transaction; the event row goes
    // with it. `secondCeremonyId` is a second provisional ceremony at a
    // different pole, seeded alongside the first.
    const store = new PgFactionStore(db);
    await store.reserve(args(ceremonyId));
    expect(await store.reserve(args(secondCeremonyId, { poleKey: "4:5:6", texture: "Flag_Rex" })))
      .toBe("tag-taken");
    expect(await events()).toHaveLength(1);
  });

  /** Reserve, then hand back the faction's id. */
  const reserved = async () => {
    await new PgFactionStore(db).reserve(args(ceremonyId));
    const [f] = await db.select().from(factions);
    return f!.id;
  };

  it("writes activated with the raiser's gamertag", async () => {
    const id = await reserved();
    expect(await new PgCeremonyStore(db).activate(id, now, "Racer")).toBe(true);

    const rows = await events();
    expect(rows.at(-1)!.kind).toBe("activated");
    expect(rows.at(-1)!.payload).toMatchObject({ actor: "Racer", tag: "BEAR" });
  });

  describe("a solo already holding the ceremony's pole", () => {
    /** A solo declaration at the claim's pole, evidenced by a raise the log holds. */
    const soloAt = async (dayzId: string) => {
      const [a] = await db.insert(admFiles).values({
        serverId, filename: `${dayzId}.ADM`, bootAt: now, linesIngested: 0, complete: true,
      }).returning();
      await db.insert(eventRows).values({
        serverId, admFileId: a!.id, lineIndex: 0, type: "flag.raised", occurredAt: now,
        payload: {
          dayzId, gamertag: "G", texture: "Flag_White", poleKey: "10000:2:10000",
          pole: { x: 10000, y: 2, z: 10000 },
        },
      });
      expect(await declareSolo(db, { serverId, dayzId, poleKey: "10000:2:10000", at: now }))
        .toMatchObject({ ok: true });
    };

    it("releases the solo's declaration when they are on the roster", async () => {
      // Spec §5.2: a solo who joins a clan releases their declaration — and
      // Task 6 lets a ceremony at a solo-declared pole proceed when that solo
      // is a participant. Without the release the founding would hit
      // declarations_pole_uniq and be told the pole is taken by itself.
      await soloAt("u1");
      expect(await new PgFactionStore(db).reserve(args(ceremonyId))).toBe("ok");
      expect(await declarationForPlayer(db, serverId, "u1")).toBeNull();
    });

    it("⚠️ leaves a stranger's declaration standing and refuses the claim", async () => {
      // The release is only ever the roster's own. A solo who is not founding
      // this clan keeps their pole; the claim is refused, not stolen.
      await soloAt("stranger");
      expect(await new PgFactionStore(db).reserve(args(ceremonyId))).toBe("pole-taken");
      expect(await declarationForPlayer(db, serverId, "stranger")).toMatchObject({ poleKey: "10000:2:10000" });
    });
  });

  it("⚠️ writes no activated row when the guarded update matches nothing", async () => {
    // activate() is guarded on status = 'reserved'; a concurrent lapse must
    // produce neither a transition nor an announcement of one.
    const id = await reserved();
    const store = new PgCeremonyStore(db);
    await store.activate(id, now, "Racer");
    const before = (await events()).length;
    expect(await store.activate(id, now, "Racer")).toBe(false);
    expect(await events()).toHaveLength(before);
  });
});
