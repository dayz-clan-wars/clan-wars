import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, events, admFiles, declarations, poles, type Database,
} from "@factions/db";
import { RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { PgRebindStore } from "../src/rebind-store.js";
import { declarationForFaction } from "../src/declaration-store.js";

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

  const raiseAt = (o: {
    poleKey: string; texture?: string; dayzId?: string; occurredAt?: Date; serverIdOverride?: number;
  }) => db.insert(events).values({
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
      pole: { x: 9, y: 8, z: 7 },
    },
  }).returning();

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
});
