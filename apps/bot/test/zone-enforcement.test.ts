import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events,
  factionMembers, declarations, zoneIncidents, zoneViolations, zonePlacements,
  zoneIncidentParticipants, clanNotices, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { zoneTick } from "../src/zone-tick.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-15T12:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);
const MEMBER = "M".repeat(40); const STRANGER = "X".repeat(40); const FRIEND = "F".repeat(40);

describe("zoneTick enforcement", () => {
  let db: Database; let serverId = 0; let admFileId = 0; let factionId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table bans, zone_incident_participants, zone_violations, zone_placements, zone_incidents, intruder_sightings, clan_notices, declarations, poles, faction_members, factions, identity_links, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id; line = 0;
    factionId = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: at(-100_000), x: 5000, z: 5000 })).id;
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: MEMBER, discordId: "1", role: "leader", joinedAt: now, status: "full" },
    ]);
  });

  const structure = (dayzId: string, x: number, z: number, part: string, kind: "base.built" | "base.dismantled", str = "Fence", when = now) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: kind, occurredAt: when,
      payload: { dayzId, gamertag: "Sasha", action: kind === "base.built" ? "built" : "dismantled", part, structure: str, tool: null, pos: { x, y: 100, z } },
    }).returning({ id: events.id });

  const placed = (dayzId: string, x: number, y: number, z: number, itemClass: string, when = now) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: "item.placed", occurredAt: when,
      payload: { dayzId, gamertag: "Sasha", item: itemClass, itemClass, pos: { x, y, z } },
    }).returning({ id: events.id });

  const incidents = () => db.select().from(zoneIncidents).orderBy(zoneIncidents.id);
  const violations = () => db.select().from(zoneViolations).orderBy(zoneViolations.id);

  it("a non-member dismantling inside the zone opens an incident and counts the loss", async () => {
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled");
    await structure(STRANGER, 5011, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now, enforcementEnabled: true });
    const [i] = await incidents();
    expect(i).toMatchObject({ partsDismantled: 2, partsBuilt: 0, hasBreach: false, hasGate: false, closedAt: null });
    expect(await violations()).toHaveLength(2);
  });

  // IMPORTANT 4 regression: with the flag off (the default), the incident
  // WRITE must not happen at all — otherwise zone_incidents_one_open keeps
  // ONE open row per declaration absorbing every act until an operator
  // enables the flag, which then closes it and warns every participant
  // accumulated at once. The pre-existing dismantle ALERT (predates this
  // branch) must keep firing regardless.
  it("with enforcementEnabled off, a non-member dismantle still alerts the owner but writes no incident", async () => {
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now, enforcementEnabled: false });
    expect(await incidents()).toHaveLength(0);
    expect(await violations()).toHaveLength(0);
    const notices = await db.select().from(clanNotices).where(eq(clanNotices.kind, "dismantle"));
    expect(notices).toHaveLength(1);
  });

  it("a full member is never a violation", async () => {
    await structure(MEMBER, 5010, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now, enforcementEnabled: true });
    expect(await incidents()).toHaveLength(0);
  });

  it("an act outside the zone is never a violation", async () => {
    await structure(STRANGER, 5300, 5300, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now, enforcementEnabled: true });
    expect(await incidents()).toHaveLength(0);
  });

  it("building is a breach, and a gate sets hasGate too", async () => {
    await structure(STRANGER, 5010, 5010, "Watchtower Kit", "base.built");
    await structure(STRANGER, 5012, 5010, "Gate", "base.built");
    await zoneTick(db, { now, enforcementEnabled: true });
    const [i] = await incidents();
    expect(i).toMatchObject({ partsBuilt: 2, hasBreach: true, hasGate: true });
  });

  // The SNA raid, 2026-09-22 02:13–02:47 UTC: four CarTents and a LargeTent,
  // each placed from the ground (311.6–311.8 m) and 3–30 m apart, then
  // climbed — the raiders' emotes were logged 3–7 m above them. Nothing was
  // stacked, so boostStackFor could never have seen it; ONE tent is the act.
  const tent = (dayzId: string, x: number, z: number, itemClass = "CarTent", item = "Car Tent", when = now) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: "item.placed", occurredAt: when,
      payload: { dayzId, gamertag: "Sasha", item, itemClass, pos: { x, y: 311.8, z } },
    }).returning({ id: events.id });

  it("a single tent placed by a non-member is a breach, sentenced as a build", async () => {
    await tent(STRANGER, 5025, 5010);
    await zoneTick(db, { now, enforcementEnabled: true });
    const [i] = await incidents();
    expect(i).toMatchObject({ partsBuilt: 1, stackItems: 0, hasBreach: true, hasGate: false });
    expect(await violations()).toMatchObject([{ kind: "build", what: "Car Tent", dayzId: STRANGER }]);
    expect(await db.select().from(zonePlacements)).toHaveLength(0);
  });

  it("the owner is told a tent went up, naming it, even with enforcement off", async () => {
    await tent(STRANGER, 5025, 5010, "MediumTent_Green", "Medium Tent");
    await zoneTick(db, { now, enforcementEnabled: false });
    expect(await incidents()).toHaveLength(0);
    const notices = await db.select().from(clanNotices).where(eq(clanNotices.kind, "built"));
    expect(notices.map((n) => n.payload)).toEqual([{ gamertag: "Sasha", part: "Medium Tent" }]);
  });

  it("a member's own tent is never a violation", async () => {
    await tent(MEMBER, 5025, 5010, "LargeTent", "Large Tent");
    await zoneTick(db, { now, enforcementEnabled: true });
    expect(await incidents()).toHaveLength(0);
  });

  it("a tent outside the zone is never a violation", async () => {
    await tent(STRANGER, 5300, 5300);
    await zoneTick(db, { now, enforcementEnabled: true });
    expect(await incidents()).toHaveLength(0);
  });

  it("five tents from three raiders are one incident, five builds, three participants", async () => {
    const A = "A".repeat(40); const B = "B".repeat(40);
    await tent(STRANGER, 5033, 5001);
    await tent(A, 5042, 5001, "CarTent", "Car Tent", at(12 * 60_000));
    await tent(B, 5040, 5001, "CarTent", "Car Tent", at(17 * 60_000));
    await tent(B, 5012, 4990, "CarTent", "Car Tent", at(19 * 60_000));
    const [last] = await tent(STRANGER, 5015, 4993, "LargeTent", "Large Tent", at(34 * 60_000));
    await zoneTick(db, { now: at(35 * 60_000), enforcementEnabled: true });
    // A replay must not re-count: recordViolation dedups on the event id.
    await db.execute(sql`update consumer_cursors set last_event_id = ${last!.id - 4} where consumer_name = 'zone-watch'`);
    await zoneTick(db, { now: at(35 * 60_000), enforcementEnabled: true });
    expect(await incidents()).toMatchObject([{ partsBuilt: 5, hasBreach: true }]);
    expect(await db.select().from(zoneIncidentParticipants)).toHaveLength(3);
  });

  it("a lone fireplace is recorded but is not a violation", async () => {
    await placed(STRANGER, 5010, 100, 5010, "Fireplace");
    await zoneTick(db, { now, enforcementEnabled: true });
    expect(await db.select().from(zonePlacements)).toHaveLength(1);
    expect(await incidents()).toHaveLength(0);
  });

  it("a co-located pair with a rise is a stack: one breach, both items counted", async () => {
    await placed(STRANGER, 5010, 100.0, 5010, "Fireplace");
    await placed(STRANGER, 5010.3, 100.9, 5010.2, "GardenPlot", at(60_000));
    await zoneTick(db, { now: at(120_000), enforcementEnabled: true });
    const [i] = await incidents();
    expect(i).toMatchObject({ stackItems: 2, hasBreach: true, hasGate: false });
  });

  it("three garden plots side by side are a farm, not a stack", async () => {
    await placed(STRANGER, 5010, 100, 5010, "GardenPlot");
    await placed(STRANGER, 5013, 100, 5010, "GardenPlot", at(60_000));
    await placed(STRANGER, 5016, 100, 5010, "GardenPlot", at(120_000));
    await zoneTick(db, { now: at(180_000), enforcementEnabled: true });
    expect(await incidents()).toHaveLength(0);
  });

  it("a genuine three-high stack counts exactly 3 stackItems and 3 violation rows, not the triangular sum", async () => {
    await placed(STRANGER, 5010, 100.0, 5010, "Fireplace");
    await placed(STRANGER, 5010.2, 100.5, 5010.1, "GardenPlot", at(20_000));
    await placed(STRANGER, 5010.1, 101.0, 5010.2, "GardenPlot", at(40_000));
    await zoneTick(db, { now: at(120_000), enforcementEnabled: true });
    const [i] = await incidents();
    expect(i).toMatchObject({ stackItems: 3, hasBreach: true });
    const stackViolations = (await violations()).filter((v) => v.kind === "stack");
    expect(stackViolations).toHaveLength(3);
  });

  it("re-running the tick over the same stack leaves stackItems at 3 — per-member dedup, not a re-count", async () => {
    await placed(STRANGER, 5010, 100.0, 5010, "Fireplace");
    await placed(STRANGER, 5010.2, 100.5, 5010.1, "GardenPlot", at(20_000));
    const [last] = await placed(STRANGER, 5010.1, 101.0, 5010.2, "GardenPlot", at(40_000));
    await zoneTick(db, { now: at(120_000), enforcementEnabled: true });
    await db.execute(sql`update consumer_cursors set last_event_id = ${last!.id - 1} where consumer_name = 'zone-watch'`);
    await zoneTick(db, { now: at(120_000), enforcementEnabled: true });
    const [i] = await incidents();
    expect(i!.stackItems).toBe(3);
    expect((await violations()).filter((v) => v.kind === "stack")).toHaveLength(3);
  });

  it("every contributor to one incident becomes a participant, gamertag frozen", async () => {
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled");
    await structure(FRIEND, 5011, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now, enforcementEnabled: true });
    const [i] = await incidents();
    const parts = await db.select().from(zoneIncidentParticipants).where(eq(zoneIncidentParticipants.incidentId, i!.id));
    expect(parts.map((p) => p.dayzId).sort()).toEqual([FRIEND, STRANGER].sort());
    expect(parts.every((p) => p.gamertag === "Sasha")).toBe(true);
  });

  it("acts separated by more than the gap belong to different incidents", async () => {
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now, enforcementEnabled: true });
    await db.update(zoneIncidents).set({ closedAt: at(60_000) });
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled", "Fence", at(120_000));
    await zoneTick(db, { now: at(180_000), enforcementEnabled: true });
    expect(await incidents()).toHaveLength(2);
  });

  it("a replayed event does not double-count damage", async () => {
    const [e] = await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now, enforcementEnabled: true });
    await db.execute(sql`update consumer_cursors set last_event_id = ${e!.id - 1} where consumer_name = 'zone-watch'`);
    await zoneTick(db, { now, enforcementEnabled: true });
    const [i] = await incidents();
    expect(i!.partsDismantled).toBe(1);
    expect(await violations()).toHaveLength(1);
  });

  it("a stale act is skipped entirely — a rewound cursor cannot manufacture incidents", async () => {
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled", "Fence", at(-10 * 86_400_000));
    await zoneTick(db, { now, enforcementEnabled: true });
    expect(await incidents()).toHaveLength(0);
  });
});
