import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factionMembers, membershipHistory, type Database,
} from "@factions/db";
import { sql, eq, and } from "drizzle-orm";
import { membershipTick, membershipAt } from "../src/membership-tick.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);

describe("membershipTick / membershipAt", () => {
  let db: Database;
  let serverId = 0;
  let factionAId = 0;
  let factionBId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table membership_history, faction_members, declarations, poles, factions, events, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;

    const a = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", createdAt: ago(200_000), poleKey: "5000.00:100.00:5000.00" });
    factionAId = a.id;
    const b = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: ago(200_000), poleKey: "6000.00:100.00:6000.00" });
    factionBId = b.id;
  });

  it("seeds one open span per current full member on the first run, skipping pending, and is idempotent", async () => {
    await db.insert(factionMembers).values([
      { factionId: factionAId, serverId, dayzId: UID_A, discordId: "100", role: "member", joinedAt: ago(100_000), status: "full" },
      { factionId: factionBId, serverId, dayzId: UID_B, discordId: "200", role: "member", joinedAt: ago(50_000), status: "full" },
    ]);
    // A pending member with no full membership yet.
    const UID_C = "C".repeat(40);
    await db.insert(factionMembers).values({
      factionId: factionAId, serverId, dayzId: UID_C, discordId: "300", role: "member", joinedAt: now, status: "pending", pendingSince: now,
    });

    const r1 = await membershipTick(db, now);
    expect(r1).toEqual({ opened: 2, closed: 0 });

    const rows = await db.select().from(membershipHistory);
    expect(rows).toHaveLength(2);
    const rowA = rows.find((r) => r.dayzId === UID_A)!;
    expect(rowA.joinedAt.getTime()).toBe(ago(100_000).getTime());
    expect(rowA.leftAt).toBeNull();
    const rowB = rows.find((r) => r.dayzId === UID_B)!;
    expect(rowB.joinedAt.getTime()).toBe(ago(50_000).getTime());
    expect(rowB.leftAt).toBeNull();

    const r2 = await membershipTick(db, now);
    expect(r2).toEqual({ opened: 0, closed: 0 });
    expect(await db.select().from(membershipHistory)).toHaveLength(2);
  });

  it("closes a span at `now` when a full member's row disappears from faction_members", async () => {
    await db.insert(factionMembers).values({
      factionId: factionAId, serverId, dayzId: UID_A, discordId: "100", role: "member", joinedAt: ago(100_000), status: "full",
    });
    await membershipTick(db, ago(50_000));

    const t1 = ago(10_000);
    await db.delete(factionMembers).where(eq(factionMembers.dayzId, UID_A));
    const r = await membershipTick(db, t1);
    expect(r).toEqual({ opened: 0, closed: 1 });

    const [row] = await db.select().from(membershipHistory).where(eq(membershipHistory.dayzId, UID_A));
    expect(row!.leftAt?.getTime()).toBe(t1.getTime());
  });

  it("a promotion (pending -> full) opens a new span at the tick's `now`, not at faction_members.joined_at", async () => {
    // Another already-full member so the first tick is not empty (its seeding
    // consumes the "first run" behavior; the promotion happens on a LATER tick).
    await db.insert(factionMembers).values({
      factionId: factionBId, serverId, dayzId: UID_B, discordId: "200", role: "member", joinedAt: ago(150_000), status: "full",
    });
    const joinedAt = ago(100_000);
    await db.insert(factionMembers).values({
      factionId: factionAId, serverId, dayzId: UID_A, discordId: "100", role: "member", joinedAt, status: "pending", pendingSince: joinedAt,
    });
    // First run: UID_B is seeded; UID_A is still pending.
    expect(await membershipTick(db, ago(90_000))).toEqual({ opened: 1, closed: 0 });
    expect(await db.select().from(membershipHistory)).toHaveLength(1);

    await db.update(factionMembers).set({ status: "full" }).where(eq(factionMembers.dayzId, UID_A));
    const t2 = ago(10_000);
    const r = await membershipTick(db, t2);
    expect(r).toEqual({ opened: 1, closed: 0 });

    const [row] = await db.select().from(membershipHistory).where(eq(membershipHistory.dayzId, UID_A));
    expect(row!.joinedAt.getTime()).toBe(t2.getTime());
    expect(row!.joinedAt.getTime()).not.toBe(joinedAt.getTime());
  });

  it("a member who leaves and rejoins gets two spans; membershipAt resolves each span, the gap, and before the first", async () => {
    const firstJoin = ago(300_000);
    await db.insert(factionMembers).values({
      factionId: factionAId, serverId, dayzId: UID_A, discordId: "100", role: "member", joinedAt: firstJoin, status: "full",
    });
    await membershipTick(db, ago(250_000)); // seeds span 1: [firstJoin, open)

    const leftAt = ago(200_000);
    await db.delete(factionMembers).where(eq(factionMembers.dayzId, UID_A));
    await membershipTick(db, leftAt); // closes span 1 at leftAt

    const rejoinTickAt = ago(100_000);
    await db.insert(factionMembers).values({
      factionId: factionAId, serverId, dayzId: UID_A, discordId: "100", role: "member", joinedAt: ago(120_000), status: "full",
    });
    await membershipTick(db, rejoinTickAt); // opens span 2 at rejoinTickAt (not a first-run seed)

    const rows = await db.select().from(membershipHistory).where(eq(membershipHistory.dayzId, UID_A));
    expect(rows).toHaveLength(2);

    // Before the first span entirely.
    expect(await membershipAt(db, serverId, UID_A, ago(310_000))).toBeNull();
    // Inside the first span.
    expect(await membershipAt(db, serverId, UID_A, ago(260_000))).toBe(factionAId);
    // In the gap between the two spans.
    expect(await membershipAt(db, serverId, UID_A, ago(150_000))).toBeNull();
    // Inside the second (still-open) span.
    expect(await membershipAt(db, serverId, UID_A, ago(50_000))).toBe(factionAId);
  });

  it("membershipAt is null for a player who was never in any clan", async () => {
    expect(await membershipAt(db, serverId, "Z".repeat(40), now)).toBeNull();
  });
});
