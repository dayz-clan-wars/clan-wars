import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events,
  factionMembers, identityLinks, declarations, zoneIncidents, zoneIncidentParticipants, clanNotices,
  type Database,
} from "@factions/db";
import { VIOLATION_INCIDENT_GAP_MS } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { violationTick } from "../src/violation-tick.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-15T12:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);
const MEMBER = "M".repeat(40);
const STRANGER = "X".repeat(40);
const UNLINKED = "U".repeat(40);

describe("violationTick", () => {
  let db: Database; let serverId = 0; let admFileId = 0; let factionId = 0; let declarationId = 0; let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table bans, zone_incident_participants, zone_violations, zone_placements, zone_incidents, intruder_sightings, clan_notices, declarations, poles, faction_members, factions, identity_links, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id; line = 0;
    const faction = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: at(-100_000), x: 5000, z: 5000 });
    factionId = faction.id;
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: MEMBER, discordId: "1", role: "leader", joinedAt: now, status: "full" },
    ]);
    const [d] = await db.select({ id: declarations.id }).from(declarations).where(eq(declarations.ownerFactionId, factionId));
    declarationId = d!.id;
    await db.insert(identityLinks).values({ dayzId: STRANGER, discordId: "99", gamertag: "Sasha", verifiedAt: now });
  });

  const seedIncident = async (lastActAt: Date, participants: string[]) => {
    const [incident] = await db.insert(zoneIncidents).values({
      serverId, declarationId, openedAt: lastActAt, lastActAt,
      partsDismantled: 2, partsBuilt: 1, stackItems: 0,
    }).returning({ id: zoneIncidents.id });
    for (const dayzId of participants) {
      await db.insert(zoneIncidentParticipants).values({ incidentId: incident!.id, dayzId, gamertag: "Sasha" });
    }
    return incident!.id;
  };

  it("closes an incident that has been quiet for the gap and warns each linked participant once", async () => {
    await seedIncident(at(-VIOLATION_INCIDENT_GAP_MS - 60_000), [STRANGER]);
    const r = await violationTick(db, { now });
    expect(r).toMatchObject({ closed: 1, warned: 1 });
    const [n] = await db.select().from(clanNotices).where(eq(clanNotices.kind, "zone_warning"));
    expect(n).toMatchObject({ target: "dm", discordTargetId: "99", factionId: null });
    expect(n!.payload).not.toHaveProperty("x");
  });

  it("does not close an incident still inside the gap", async () => {
    await seedIncident(at(-60_000), [STRANGER]);
    expect(await violationTick(db, { now })).toMatchObject({ closed: 0, warned: 0 });
  });

  it("warns each participant exactly once, even across two ticks", async () => {
    await seedIncident(at(-VIOLATION_INCIDENT_GAP_MS - 60_000), [STRANGER]);
    await violationTick(db, { now });
    await violationTick(db, { now });
    expect(await db.select().from(clanNotices).where(eq(clanNotices.kind, "zone_warning"))).toHaveLength(1);
  });

  it("an unlinked participant gets no DM but the incident still closes", async () => {
    await seedIncident(at(-VIOLATION_INCIDENT_GAP_MS - 60_000), [UNLINKED]);
    const r = await violationTick(db, { now });
    expect(r).toMatchObject({ closed: 1, warned: 0 });
  });
});
