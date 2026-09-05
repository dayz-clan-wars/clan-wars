import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, events, admFiles, declarations, poles, type Database,
} from "@factions/db";
import { RELEASED_POLE_GRACE_MS, parsePoleKey } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { PgRebindStore } from "../src/rebind-store.js";
import { declarationForFaction } from "@factions/declarations";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const UID_MEMBER = "A".repeat(40);
const UID_STRANGER = "B".repeat(40);

// Both far from the Hub (100, 93) and far from each other — 200 m of anyone
// else is now enforced by declareTx, so fixtures can no longer sit near
// (1,1,1)/(9,8,7), which the old Flag_White design put well inside the Hub's
// exclusion zone.
const P1 = { x: 10000, y: 100, z: 10000 };
const P2 = { x: 20000, y: 100, z: 20000 };
const P1_KEY = "10000.00:100.00:10000.00";
const P2_KEY = "20000.00:100.00:20000.00";

describe("PgRebindStore", () => {
  let db: Database;
  let store: PgRebindStore;
  let serverId = 0;
  let admFileId = 0;
  let factionId = 0;
  let lineIndex = 0;
  let p2EventId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table declarations, poles, events, raw_lines, adm_files, faction_members, factions, servers restart identity cascade`);
    });
    store = new PgRebindStore(db);
    lineIndex = 0;

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({
      serverId, filename: "a.ADM", bootAt: ago(999_999),
    }).returning();
    admFileId = f!.id;

    const [faction] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
      status: "active", leaderDiscordId: "leader", createdAt: ago(999_999), activatedAt: ago(999_999),
    }).returning();
    factionId = faction!.id;

    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: UID_MEMBER, discordId: "leader", role: "leader", joinedAt: ago(999_999) },
    ]);

    // The founding evidence for the faction's P1 declaration — the pole
    // binding now lives in `declarations`, not on `factions`.
    const [founding] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, subIndex: 0,
      type: "flag.raised", occurredAt: ago(999_999),
      payload: { poleKey: P1_KEY, texture: "Flag_Bear", dayzId: UID_MEMBER, gamertag: "Founder", pole: P1 },
    }).returning();

    await db.insert(declarations).values({
      serverId, poleKey: P1_KEY, x: P1.x.toFixed(2), y: P1.y.toFixed(2), z: P1.z.toFixed(2),
      ownerFactionId: factionId, evidenceEventId: founding!.id, declaredAt: ago(999_999),
    });

    await db.insert(poles).values([
      {
        serverId, map: "livonia", poleKey: P1_KEY,
        x: P1.x.toFixed(2), y: P1.y.toFixed(2), z: P1.z.toFixed(2),
        currentTexture: "Flag_Bear", flagRaised: true,
        firstSeenAt: ago(999_999), lastSeenAt: ago(999_999), graceUntil: now,
      },
      {
        serverId, map: "livonia", poleKey: P2_KEY,
        x: P2.x.toFixed(2), y: P2.y.toFixed(2), z: P2.z.toFixed(2),
        currentTexture: null, flagRaised: false,
        firstSeenAt: ago(999_999), lastSeenAt: ago(999_999), graceUntil: now,
      },
    ]);

    // The member's raise at P2 — the rebind target most tests move to.
    const [p2Raise] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, subIndex: 0,
      type: "flag.raised", occurredAt: ago(1000),
      payload: { poleKey: P2_KEY, texture: "Flag_Bear", dayzId: UID_MEMBER, gamertag: "Raiser", pole: P2 },
    }).returning();
    p2EventId = p2Raise!.id;
  });

  // ⚠️ The coordinates are DERIVED from the key, never given separately. The
  // key IS the coordinate string, and `declareTx`'s own-pole exclusion (the
  // "distance 0 to myself is pole-taken, not too-close" case) only holds when
  // the two agree. A fixture whose payload said (9, 8, 7) under a key naming
  // some other point produced a raise that cannot exist in the log, and the
  // spacing check silently measured from the wrong place.
  const raiseAt = (o: {
    poleKey: string; texture?: string; dayzId?: string; occurredAt?: Date; serverIdOverride?: number;
  }) => {
    const pole = parsePoleKey(o.poleKey);
    if (!pole) throw new Error(`raiseAt: malformed poleKey ${o.poleKey}`);
    return db.insert(events).values({
      serverId: o.serverIdOverride ?? serverId,
      admFileId,
      lineIndex: lineIndex++,
      subIndex: 0,
      type: "flag.raised",
      occurredAt: o.occurredAt ?? ago(1000),
      payload: {
        poleKey: o.poleKey,
        texture: o.texture ?? "Flag_Bear",
        dayzId: o.dayzId ?? UID_MEMBER,
        gamertag: "Raiser",
        pole,
      },
    }).returning();
  };

  const target = async () => (await store.factionFor(factionId))!;

  it("reads the faction's rebind-relevant fields", async () => {
    const t = await target();
    expect(t.texture).toBe("Flag_Bear");
    expect(t.poleKey).toBe(P1_KEY);
    expect(t.status).toBe("active");
    expect(t.reboundAt).toBeNull();
  });

  it("finds a member's raise of the faction's own texture at another pole", async () => {
    await raiseAt({ poleKey: "9.00:8.00:7.00" });
    const out = await store.qualifyingRaises(await target(), ago(3_600_000));
    // Two raises now: the P2 raise seeded in beforeEach, plus this one.
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.poleKey)).toContain("9.00:8.00:7.00");
    const nine = out.find((r) => r.poleKey === "9.00:8.00:7.00")!;
    expect(nine.x).toBe(9);
    expect(nine.y).toBe(8);
    expect(nine.z).toBe(7);
  });

  it("⚠️ ignores a raise by someone who is not on the roster", async () => {
    // A rebind moves the faction's identity to coordinates of someone's
    // choosing. If a stranger's raise could supply that target, anyone could
    // relocate any faction to a pole they control.
    await raiseAt({ poleKey: "9.00:8.00:7.00", dayzId: UID_STRANGER });
    const out = await store.qualifyingRaises(await target(), ago(3_600_000));
    expect(out.map((r) => r.poleKey)).not.toContain("9.00:8.00:7.00");
  });

  it("ignores a raise of a different texture", async () => {
    await raiseAt({ poleKey: "9.00:8.00:7.00", texture: "Flag_Wolf" });
    const out = await store.qualifyingRaises(await target(), ago(3_600_000));
    expect(out.map((r) => r.poleKey)).not.toContain("9.00:8.00:7.00");
  });

  it("ignores a raise at a pole another declaration already owns", async () => {
    const [wolves] = await db.insert(factions).values({
      serverId, name: "Wolves", tag: "WOLF", texture: "Flag_Wolf", status: "active",
      leaderDiscordId: "other", createdAt: ago(999_999),
    }).returning();
    const [ev] = await raiseAt({ poleKey: "9.00:8.00:7.00", texture: "Flag_Wolf", dayzId: "wolf-founder".padEnd(40, "0") });
    await db.insert(declarations).values({
      serverId, poleKey: "9.00:8.00:7.00", x: "9.00", y: "8.00", z: "7.00",
      ownerFactionId: wolves!.id, evidenceEventId: ev!.id, declaredAt: ago(999_999),
    });
    await raiseAt({ poleKey: "9.00:8.00:7.00" });
    const out = await store.qualifyingRaises(await target(), ago(3_600_000));
    expect(out.map((r) => r.poleKey)).not.toContain("9.00:8.00:7.00");
  });

  it("ignores a raise older than the window", async () => {
    await raiseAt({ poleKey: "9.00:8.00:7.00", occurredAt: ago(7_200_000) });
    const out = await store.qualifyingRaises(await target(), ago(3_600_000));
    expect(out.map((r) => r.poleKey)).not.toContain("9.00:8.00:7.00");
  });

  it("ignores a raise on another server", async () => {
    const [other] = await db.insert(servers).values({ name: "Other", map: "livonia", clockOffsetMs: 0 }).returning();
    await raiseAt({ poleKey: "9.00:8.00:7.00", serverIdOverride: other!.id });
    const out = await store.qualifyingRaises(await target(), ago(3_600_000));
    expect(out.map((r) => r.poleKey)).not.toContain("9.00:8.00:7.00");
  });

  const args = (over: Partial<Parameters<PgRebindStore["rebind"]>[0]> = {}) => ({
    factionId, leaderDiscordId: "leader",
    expectedPoleKey: P1_KEY,
    poleKey: P2_KEY, x: P2.x, y: P2.y, z: P2.z,
    evidenceEventId: p2EventId,
    at: now, notBefore: ago(604_800_000),
    ...over,
  });

  it("moves the declaration and gives the old pole its 3-day grace", async () => {
    const out = await store.rebind(args());
    expect(out).toBe("ok");
    expect(await declarationForFaction(db, factionId)).toMatchObject({ poleKey: P2_KEY });
    const [old] = await db.select().from(poles).where(eq(poles.poleKey, P1_KEY));
    expect(old!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);
  });

  it("refuses a target within 200 m of another declaration", async () => {
    // A second, solo declaration ~150 m from P2.
    const nearP2Key = "20150.00:100.00:20000.00";
    const [ev] = await raiseAt({ poleKey: nearP2Key, dayzId: "C".repeat(40) });
    await db.insert(declarations).values({
      serverId, poleKey: nearP2Key, x: "20150.00", y: "100.00", z: "20000.00",
      ownerDayzId: "C".repeat(40), evidenceEventId: ev!.id, declaredAt: ago(999_999),
    });

    expect(await store.rebind(args())).toBe("too-close");
    expect(await declarationForFaction(db, factionId)).toMatchObject({ poleKey: P1_KEY });
  });

  it("moves the pole, activates, and clears dormancy in one write", async () => {
    await db.update(factions).set({ status: "dormant", dormantSince: ago(5000) })
      .where(eq(factions.id, factionId));

    expect(await store.rebind(args())).toBe("ok");

    const [row] = await db.select().from(factions).where(eq(factions.id, factionId));
    expect(row!.status).toBe("active");
    expect(row!.dormantSince).toBeNull();
    expect(row!.reboundAt).toEqual(now);

    const decl = await declarationForFaction(db, factionId);
    expect(decl).toMatchObject({ poleKey: P2_KEY });
    expect(Number(decl!.x)).toBe(P2.x);
    expect(Number(decl!.y)).toBe(P2.y);
    expect(Number(decl!.z)).toBe(P2.z);
  });

  it("refuses a non-leader", async () => {
    expect(await store.rebind(args({ leaderDiscordId: "someone-else" }))).toBe("refused");
  });

  it("refuses inside the cooldown", async () => {
    await db.update(factions).set({ reboundAt: ago(1000) }).where(eq(factions.id, factionId));
    expect(await store.rebind(args())).toBe("refused");
  });

  it("⚠️ refuses when the pole moved since the candidate was read", async () => {
    // Two leaders confirming two different candidates concurrently must produce
    // one move and one refusal, not two writes. expectedPoleKey is the guard.
    expect(await store.rebind(args({ expectedPoleKey: "stale" }))).toBe("refused");
  });

  it("refuses a reserved faction", async () => {
    await db.update(factions).set({ status: "reserved", reservedUntil: now })
      .where(eq(factions.id, factionId));
    expect(await store.rebind(args())).toBe("refused");
  });

  it("refuses a disbanded faction", async () => {
    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, factionId));
    expect(await store.rebind(args())).toBe("refused");
  });

  it("⚠️ two clans rebinding at once on one server do not deadlock", async () => {
    // The shape this pins: `rebind` calls `releaseTx` (which DELETEs a
    // `declarations` row, taking a row lock) and then `declareTx` (whose
    // first statement is the server's advisory lock, followed by
    // `SELECT … FROM declarations FOR UPDATE`). Deleting before taking the
    // advisory lock inverts those two, so T1 holds a row lock and waits for
    // the advisory lock while T2 holds the advisory lock and blocks on T1's
    // uncommitted delete. Postgres resolves that by ABORTING one of them
    // with a raw driver error — not a `RebindAbort` — so it escapes the
    // outcome mapping entirely and reaches a player as a crashed command.
    // `lockDeclarations` before the release is what keeps the order the same
    // for everyone. Every legitimate outcome is accepted here; a THROW is
    // the failure.
    const P3 = { x: 30000, y: 100, z: 30000 };
    const P4 = { x: 40000, y: 100, z: 40000 };
    const P3_KEY = "30000.00:100.00:30000.00";
    const P4_KEY = "40000.00:100.00:40000.00";
    const UID_WOLF = "W".repeat(40);

    const [wolves] = await db.insert(factions).values({
      serverId, name: "Wolves", tag: "WOLF", texture: "Flag_Wolf",
      status: "active", leaderDiscordId: "wolf-leader",
      createdAt: ago(999_999), activatedAt: ago(999_999),
    }).returning();
    await db.insert(factionMembers).values({
      factionId: wolves!.id, serverId, dayzId: UID_WOLF,
      discordId: "wolf-leader", role: "leader", joinedAt: ago(999_999),
    });
    const [wolfFounding] = await raiseAt({ poleKey: P3_KEY, texture: "Flag_Wolf", dayzId: UID_WOLF, occurredAt: ago(999_999) });
    await db.insert(declarations).values({
      serverId, poleKey: P3_KEY, x: P3.x.toFixed(2), y: P3.y.toFixed(2), z: P3.z.toFixed(2),
      ownerFactionId: wolves!.id, evidenceEventId: wolfFounding!.id, declaredAt: ago(999_999),
    });
    await db.insert(poles).values([
      {
        serverId, map: "livonia", poleKey: P3_KEY,
        x: P3.x.toFixed(2), y: P3.y.toFixed(2), z: P3.z.toFixed(2),
        currentTexture: "Flag_Wolf", flagRaised: true,
        firstSeenAt: ago(999_999), lastSeenAt: ago(999_999), graceUntil: now,
      },
      {
        serverId, map: "livonia", poleKey: P4_KEY,
        x: P4.x.toFixed(2), y: P4.y.toFixed(2), z: P4.z.toFixed(2),
        currentTexture: null, flagRaised: false,
        firstSeenAt: ago(999_999), lastSeenAt: ago(999_999), graceUntil: now,
      },
    ]);
    const [wolfTarget] = await raiseAt({ poleKey: P4_KEY, texture: "Flag_Wolf", dayzId: UID_WOLF });

    // Both rebinds are made to arrive INSIDE the same window on purpose: a
    // third session holds the server's declaration lock while they start, so
    // both reach the point where they want it, and only then is it handed
    // over. Left to chance, two `Promise.all` rebinds finish too fast to
    // overlap and the test passes with the bug present — it did, five runs
    // out of five, before this gate was added.
    const gate = createClient(URL);
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const holding = gate.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('declarations'), ${serverId})`);
      await released;
      // Read the declarations the way declareTx does, still holding the lock:
      // this is the statement that blocks on an uncommitted delete when a
      // rebind released before queueing for the advisory lock.
      await tx.execute(sql`select 1 from declarations where server_id = ${serverId} for update`);
    });

    const running = Promise.all([
      store.rebind(args()),
      store.rebind({
        factionId: wolves!.id, leaderDiscordId: "wolf-leader",
        expectedPoleKey: P3_KEY,
        poleKey: P4_KEY, x: P4.x, y: P4.y, z: P4.z,
        evidenceEventId: wolfTarget!.id,
        at: now, notBefore: ago(604_800_000),
      }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holding;
    const outcomes = await running;

    for (const o of outcomes) expect(["ok", "too-close", "refused"]).toContain(o);

    // Consistent afterwards: each clan holds exactly one declaration, and it
    // is either where it started or where it was going — never both, never
    // neither.
    const bear = await declarationForFaction(db, factionId);
    const wolf = await declarationForFaction(db, wolves!.id);
    expect([P1_KEY, P2_KEY]).toContain(bear!.poleKey);
    expect([P3_KEY, P4_KEY]).toContain(wolf!.poleKey);
    const rows = await db.select({ id: declarations.id }).from(declarations);
    expect(rows).toHaveLength(2);
  });
});
