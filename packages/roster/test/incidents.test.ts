import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, players, declarations, poles, events, admFiles,
  zoneIncidents, zoneIncidentParticipants, zoneViolations, bans,
  type Database,
} from "@factions/db";
import { VIOLATION_REPORT_WINDOW_MS } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { reportableIncidentsDb, reportIncidentDb } from "../src/internal/incidents";
import { seedFaction, seedSeason } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-15T12:00:00Z");
const closedAt = new Date(now.getTime() - 60_000);
const openedAt = new Date(closedAt.getTime() - 300_000);

const OFFICER_DAYZ = "O".repeat(40);
const MEMBER_DAYZ = "M".repeat(40);
const STRANGER_DAYZ = "S".repeat(40);
const OFFENDER_1 = "F".repeat(40);
const OFFENDER_2 = "G".repeat(40);

const OFFICER_DISCORD = "d-officer";
const MEMBER_DISCORD = "d-member";
const STRANGER_DISCORD = "d-stranger";

describe("reportable incidents and pressing charges", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;
  let declarationId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table bans, zone_incident_participants, zone_violations, zone_placements, zone_incidents, intruder_sightings, clan_notices, declarations, poles, faction_members, factions, identity_links, players, events, raw_lines, adm_files, seasons, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;

    const faction = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: new Date(openedAt.getTime() - 100_000), x: 5000, z: 5000 });
    factionId = faction.id;
    const [d] = await db.select({ id: declarations.id }).from(declarations).where(eq(declarations.ownerFactionId, factionId));
    declarationId = d!.id;

    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: OFFICER_DAYZ, discordId: OFFICER_DISCORD, role: "officer", joinedAt: now, status: "full" },
      { factionId, serverId, dayzId: MEMBER_DAYZ, discordId: MEMBER_DISCORD, role: "member", joinedAt: now, status: "full" },
    ]);
    await db.insert(identityLinks).values([
      { discordId: OFFICER_DISCORD, dayzId: OFFICER_DAYZ, gamertag: "Officer", verifiedAt: now },
      { discordId: MEMBER_DISCORD, dayzId: MEMBER_DAYZ, gamertag: "Member", verifiedAt: now },
      { discordId: STRANGER_DISCORD, dayzId: STRANGER_DAYZ, gamertag: "Stranger", verifiedAt: now },
    ]);
    await db.insert(players).values([
      { dayzId: OFFICER_DAYZ, gamertag: "Officer", firstSeenAt: now, lastSeenAt: now },
      { dayzId: MEMBER_DAYZ, gamertag: "Member", firstSeenAt: now, lastSeenAt: now },
      { dayzId: STRANGER_DAYZ, gamertag: "Stranger", firstSeenAt: now, lastSeenAt: now },
      { dayzId: OFFENDER_1, gamertag: "Offender1", firstSeenAt: now, lastSeenAt: now },
      { dayzId: OFFENDER_2, gamertag: "Offender2", firstSeenAt: now, lastSeenAt: now },
    ]);
  });

  const seedIncident = async (
    opts: Partial<{ closedAt: Date | null; reportedAt: Date | null; partsDismantled: number; hasBreach: boolean; declarationId: number }> = {},
  ) => {
    const [incident] = await db.insert(zoneIncidents).values({
      serverId, declarationId: opts.declarationId ?? declarationId,
      openedAt, lastActAt: closedAt,
      closedAt: "closedAt" in opts ? opts.closedAt : closedAt,
      reportedAt: opts.reportedAt ?? null,
      partsDismantled: opts.partsDismantled ?? 4, partsBuilt: 0, stackItems: 0,
      hasBreach: opts.hasBreach ?? false, hasGate: false,
    }).returning({ id: zoneIncidents.id });
    for (const dayzId of [OFFENDER_1, OFFENDER_2]) {
      await db.insert(zoneIncidentParticipants).values({ incidentId: incident!.id, dayzId, gamertag: dayzId === OFFENDER_1 ? "Offender1" : "Offender2" });
    }
    await db.insert(zoneViolations).values({
      incidentId: incident!.id, eventId: incident!.id * 10, kind: "dismantle", dayzId: OFFENDER_1,
      what: "Fence", x: "5010.00", y: "100.00", z: "5010.00", occurredAt: closedAt,
    });
    return incident!.id;
  };

  it("a solo declarant sees incidents at their own base and nobody else's", async () => {
    await db.execute(sql`truncate table declarations, faction_members, factions restart identity cascade`);
    const [pole1] = await db.insert(poles).values({
      serverId, map: "livonia", poleKey: "9000.00:100.00:9000.00", x: "9000.00", y: "100.00", z: "9000.00",
      currentTexture: "Flag_White", flagRaised: true, firstSeenAt: now, lastSeenAt: now, graceUntil: now,
    }).returning();
    const [adm] = await db.insert(admFiles).values({ serverId, filename: "solo.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    const [ev] = await db.insert(events).values({
      serverId, admFileId: adm!.id, lineIndex: 0, type: "flag.raised", occurredAt: now,
      payload: { dayzId: OFFICER_DAYZ, gamertag: "Officer", texture: "Flag_White", poleKey: pole1!.poleKey, pole: { x: 9000, y: 100, z: 9000 } },
    }).returning();
    await db.insert(declarations).values({
      serverId, poleKey: pole1!.poleKey, x: "9000.00", y: "100.00", z: "9000.00",
      ownerDayzId: OFFICER_DAYZ, evidenceEventId: ev!.id, declaredAt: now,
    });
    const [d] = await db.select({ id: declarations.id }).from(declarations);
    const id = await seedIncident({ declarationId: d!.id });

    const own = await reportableIncidentsDb(db, now, OFFICER_DISCORD);
    expect(own.map((i) => i.id)).toEqual([id]);

    const stranger = await reportableIncidentsDb(db, now, STRANGER_DISCORD);
    expect(stranger).toEqual([]);
  });

  it("a clan officer sees incidents at the clan's base", async () => {
    const id = await seedIncident();
    const rows = await reportableIncidentsDb(db, now, OFFICER_DISCORD);
    expect(rows.map((i) => i.id)).toEqual([id]);
    expect(rows[0]!.participants.map((p) => p.gamertag).sort()).toEqual(["Offender1", "Offender2"]);
    expect(rows[0]!.acts).toMatchObject([{ kind: "dismantle", what: "Fence", x: 5010, z: 5010 }]);
  });

  it("a full member who is not an officer sees them but cannot report", async () => {
    const id = await seedIncident();
    const rows = await reportableIncidentsDb(db, now, MEMBER_DISCORD);
    expect(rows.map((i) => i.id)).toEqual([id]);
    expect(await reportIncidentDb(db, now, MEMBER_DISCORD, id)).toEqual({ ok: false, reason: "not-officer" });
  });

  it("an incident older than the report window is not reportable", async () => {
    const id = await seedIncident();
    const late = new Date(closedAt.getTime() + VIOLATION_REPORT_WINDOW_MS + 1000);
    expect(await reportIncidentDb(db, late, OFFICER_DISCORD, id)).toEqual({ ok: false, reason: "window-closed" });
  });

  it("an open incident is not reportable", async () => {
    const id = await seedIncident({ closedAt: null });
    expect(await reportIncidentDb(db, now, OFFICER_DISCORD, id)).toEqual({ ok: false, reason: "no-incident" });
    expect(await reportableIncidentsDb(db, now, OFFICER_DISCORD)).toEqual([]);
  });

  it("reporting writes one ban per participant with the joint incident total", async () => {
    const id = await seedIncident();
    const r = await reportIncidentDb(db, now, OFFICER_DISCORD, id);
    expect(r).toEqual({ ok: true, banned: 2 });
    const rows = await db.select().from(bans);
    expect(rows).toHaveLength(2);
    // both offenders serve the SAME term: liability is joint
    expect(new Set(rows.map((b) => b.expiresAt!.getTime())).size).toBe(1);
  });

  it("a second report on the same incident is refused", async () => {
    const id = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, id);
    expect(await reportIncidentDb(db, now, OFFICER_DISCORD, id)).toEqual({ ok: false, reason: "already-reported" });
  });

  it("a repeat offender's second upheld report doubles the term", async () => {
    const seasonStart = new Date(openedAt.getTime() - 1_000_000);
    await seedSeason(db, serverId, seasonStart);

    const first = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, first);
    const [firstBan] = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    const firstTermMs = firstBan!.expiresAt!.getTime() - firstBan!.bannedAt.getTime();

    const laterClosed = new Date(closedAt.getTime() + 1000);
    const second = await seedIncident({ closedAt: laterClosed });
    const laterNow = new Date(laterClosed.getTime() + 1000);
    await reportIncidentDb(db, laterNow, OFFICER_DISCORD, second);
    const secondRows = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    const secondBan = secondRows.find((b) => b.incidentId === second)!;
    const secondTermMs = secondBan.expiresAt!.getTime() - secondBan.bannedAt.getTime();

    expect(secondTermMs).toBe(firstTermMs * 2);
  });

  it("a third upheld report in the season is permanent — expiresAt is null", async () => {
    const seasonStart = new Date(openedAt.getTime() - 1_000_000);
    await seedSeason(db, serverId, seasonStart);

    let closedTime = closedAt.getTime();
    for (let i = 0; i < 2; i++) {
      const inc = await seedIncident({ closedAt: new Date(closedTime) });
      await reportIncidentDb(db, new Date(closedTime + 1000), OFFICER_DISCORD, inc);
      closedTime += 2000;
    }
    const third = await seedIncident({ closedAt: new Date(closedTime) });
    await reportIncidentDb(db, new Date(closedTime + 1000), OFFICER_DISCORD, third);
    const rows = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    const thirdBan = rows.find((b) => b.incidentId === third)!;
    expect(thirdBan.expiresAt).toBeNull();
  });

  it("the ban freezes dayzId and the gamertag recorded at event time", async () => {
    const id = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, id);
    const rows = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    expect(rows[0]).toMatchObject({ dayzId: OFFENDER_1, gamertag: "Offender1" });
  });

  it("a stranger cannot report an incident at a base they do not own", async () => {
    const id = await seedIncident();
    expect(await reportIncidentDb(db, now, STRANGER_DISCORD, id)).toEqual({ ok: false, reason: "not-owner" });
  });
});
