import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, players, declarations, poles, events, admFiles,
  zoneIncidents, zoneIncidentParticipants, zoneViolations, bans,
  type Database,
} from "@factions/db";
import { VIOLATION_REPORT_WINDOW_MS, sentenceMsFor, type IncidentDamage } from "@factions/domain";
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
    expect(await reportIncidentDb(db, now, MEMBER_DISCORD, id, [OFFENDER_1, OFFENDER_2])).toEqual({ ok: false, reason: "not-officer" });
  });

  it("an incident older than the report window is not reportable", async () => {
    const id = await seedIncident();
    const late = new Date(closedAt.getTime() + VIOLATION_REPORT_WINDOW_MS + 1000);
    expect(await reportIncidentDb(db, late, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2])).toEqual({ ok: false, reason: "window-closed" });
  });

  it("an open incident is not reportable", async () => {
    const id = await seedIncident({ closedAt: null });
    expect(await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2])).toEqual({ ok: false, reason: "no-incident" });
    expect(await reportableIncidentsDb(db, now, OFFICER_DISCORD)).toEqual([]);
  });

  it("reporting writes one ban per participant with the joint incident total", async () => {
    const id = await seedIncident();
    const r = await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
    expect(r).toEqual({ ok: true, banned: 2 });
    const rows = await db.select().from(bans);
    expect(rows).toHaveLength(2);
    // both offenders serve the SAME term: liability is joint
    expect(new Set(rows.map((b) => b.expiresAt!.getTime())).size).toBe(1);
  });

  it("a second report on the same incident is refused", async () => {
    const id = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
    expect(await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2])).toEqual({ ok: false, reason: "already-reported" });
  });

  it("a repeat offender's second upheld report doubles the term", async () => {
    const seasonStart = new Date(openedAt.getTime() - 1_000_000);
    await seedSeason(db, serverId, seasonStart);

    const first = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, first, [OFFENDER_1, OFFENDER_2]);
    const [firstBan] = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    const firstTermMs = firstBan!.expiresAt!.getTime() - firstBan!.bannedAt.getTime();
    // Priors only count once actually SERVED (Critical 2) — stand in for
    // ban-tick's apply arm so this test still exercises real escalation.
    await db.update(bans).set({ status: "applied", dryRun: false }).where(eq(bans.id, firstBan!.id));

    const laterClosed = new Date(closedAt.getTime() + 1000);
    const second = await seedIncident({ closedAt: laterClosed });
    const laterNow = new Date(laterClosed.getTime() + 1000);
    await reportIncidentDb(db, laterNow, OFFICER_DISCORD, second, [OFFENDER_1, OFFENDER_2]);
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
      await reportIncidentDb(db, new Date(closedTime + 1000), OFFICER_DISCORD, inc, [OFFENDER_1, OFFENDER_2]);
      // Priors only count once actually SERVED (Critical 2) — stand in for
      // ban-tick's apply arm so this test still exercises real escalation.
      await db.update(bans).set({ status: "applied", dryRun: false }).where(eq(bans.incidentId, inc));
      closedTime += 2000;
    }
    const third = await seedIncident({ closedAt: new Date(closedTime) });
    await reportIncidentDb(db, new Date(closedTime + 1000), OFFICER_DISCORD, third, [OFFENDER_1, OFFENDER_2]);
    const rows = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    const thirdBan = rows.find((b) => b.incidentId === third)!;
    expect(thirdBan.expiresAt).toBeNull();
  });

  it("the ban freezes dayzId and the gamertag recorded at event time", async () => {
    const id = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
    const rows = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    expect(rows[0]).toMatchObject({ dayzId: OFFENDER_1, gamertag: "Offender1" });
  });

  it("a stranger cannot report an incident at a base they do not own", async () => {
    const id = await seedIncident();
    expect(await reportIncidentDb(db, now, STRANGER_DISCORD, id, [OFFENDER_1, OFFENDER_2])).toEqual({ ok: false, reason: "not-owner" });
  });

  // ⚠️ Regression: seasonStartFor's fallback must be `now`, not the epoch. An
  // epoch fallback makes `bannedAt >= seasonStart` match every ban ever
  // written on the server, so a season-less database (no open season row,
  // e.g. the gap right after a wipe closes one) would count every historical
  // ban as a prior offence and turn a player's FIRST offence into a
  // permanent ban with no expire arm able to lift it.
  it("with no open season, a first offence still gets the first-offence term, not permanent", async () => {
    const id = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
    const [firstBan] = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    expect(firstBan!.expiresAt).not.toBeNull();
    const damage: IncidentDamage = { partsDismantled: 4, partsBuilt: 0, stackItems: 0, hasBreach: false, hasGate: false };
    const expectedMs = sentenceMsFor(damage, 0);
    expect(firstBan!.expiresAt!.getTime() - firstBan!.bannedAt.getTime()).toBe(expectedMs);
  });

  it("a lifted ban does not count toward the ladder", async () => {
    const seasonStart = new Date(openedAt.getTime() - 1_000_000);
    await seedSeason(db, serverId, seasonStart);

    // Two prior bans on OFFENDER_1 this season, one of them lifted.
    await db.insert(bans).values([
      { serverId, dayzId: OFFENDER_1, gamertag: "Offender1", bannedAt: new Date(openedAt.getTime() - 500_000), expiresAt: null, status: "lifted", dryRun: false },
      { serverId, dayzId: OFFENDER_1, gamertag: "Offender1", bannedAt: new Date(openedAt.getTime() - 400_000), expiresAt: new Date(openedAt.getTime() + 86_400_000), status: "applied", dryRun: false },
    ]);

    const id = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
    const rows = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    const newBan = rows.find((b) => b.incidentId === id)!;
    // Only ONE non-lifted prior counts, so this is the SECOND offence (doubled), not permanent.
    const damage: IncidentDamage = { partsDismantled: 4, partsBuilt: 0, stackItems: 0, hasBreach: false, hasGate: false };
    const expectedMs = sentenceMsFor(damage, 1);
    expect(newBan.expiresAt).not.toBeNull();
    expect(newBan.expiresAt!.getTime() - newBan.bannedAt.getTime()).toBe(expectedMs);
  });

  // ⚠️ CRITICAL regression (reverses an earlier ruling recorded in the SDD
  // ledger, "failed counts: the offence stood, only enforcement lapsed" —
  // that reasoning was wrong): a `dryRun: true` prior never reached Nitrado —
  // `BAN_DRY_RUN` defaults true, so this is the NORMAL state during a
  // dry-run period — and must not escalate the ladder. Without this
  // exclusion, two reports served during a dry-run week turn a player's
  // FIRST genuinely-enforced offence into a permanent ban.
  it("a dry-run prior does not escalate the ladder", async () => {
    const seasonStart = new Date(openedAt.getTime() - 1_000_000);
    await seedSeason(db, serverId, seasonStart);
    await db.insert(bans).values({
      serverId, dayzId: OFFENDER_1, gamertag: "Offender1",
      bannedAt: new Date(openedAt.getTime() - 400_000),
      expiresAt: new Date(openedAt.getTime() + 86_400_000),
      status: "applied", dryRun: true,
    });

    const id = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
    const rows = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    const newBan = rows.find((b) => b.incidentId === id)!;
    const damage: IncidentDamage = { partsDismantled: 4, partsBuilt: 0, stackItems: 0, hasBreach: false, hasGate: false };
    expect(newBan.expiresAt!.getTime() - newBan.bannedAt.getTime()).toBe(sentenceMsFor(damage, 0));
  });

  // ⚠️ CRITICAL regression: a `failed` prior (aged out past the apply
  // lookback, or exhausted BAN_MAX_ATTEMPTS) never reached Nitrado either —
  // it must not escalate the ladder any more than a dry-run row does.
  it("a failed prior does not escalate the ladder", async () => {
    const seasonStart = new Date(openedAt.getTime() - 1_000_000);
    await seedSeason(db, serverId, seasonStart);
    await db.insert(bans).values({
      serverId, dayzId: OFFENDER_1, gamertag: "Offender1",
      bannedAt: new Date(openedAt.getTime() - 400_000),
      expiresAt: new Date(openedAt.getTime() + 86_400_000),
      status: "failed", dryRun: false,
    });

    const id = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
    const rows = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    const newBan = rows.find((b) => b.incidentId === id)!;
    const damage: IncidentDamage = { partsDismantled: 4, partsBuilt: 0, stackItems: 0, hasBreach: false, hasGate: false };
    expect(newBan.expiresAt!.getTime() - newBan.bannedAt.getTime()).toBe(sentenceMsFor(damage, 0));
  });

  // ⚠️ CRITICAL regression: an `unlinked_pc` ban is access control, not a
  // zone punishment — and its `expires_at` is null, so it never ages into
  // `expired`. If it counted as a prior, a PC-banned player's FIRST real zone
  // offence would be sentenced as a second for the rest of the season, and
  // their second would reach the permanent tier.
  it("an unlinked_pc ban does not escalate the zone ladder", async () => {
    const seasonStart = new Date(openedAt.getTime() - 1_000_000);
    await seedSeason(db, serverId, seasonStart);
    await db.insert(bans).values({
      serverId, dayzId: OFFENDER_1, gamertag: "Offender1",
      bannedAt: new Date(openedAt.getTime() - 400_000),
      // Permanent, exactly as pcBanTick writes it: never expires, so without
      // the reason filter it is a prior offence forever.
      expiresAt: null,
      status: "applied", dryRun: false, reason: "unlinked_pc",
    });

    const id = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
    const rows = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    const newBan = rows.find((b) => b.incidentId === id)!;
    const damage: IncidentDamage = { partsDismantled: 4, partsBuilt: 0, stackItems: 0, hasBreach: false, hasGate: false };
    // Specific on purpose: dropping the reason filter makes this the SECOND
    // offence (sentenceMsFor(damage, 1)), which is a different number.
    expect(newBan.expiresAt).not.toBeNull();
    expect(newBan.expiresAt!.getTime() - newBan.bannedAt.getTime()).toBe(sentenceMsFor(damage, 0));
    expect(sentenceMsFor(damage, 1)).not.toBe(sentenceMsFor(damage, 0));
  });

  // Sanity converse: a real, enforced prior (applied, not dry-run) DOES escalate.
  it("an applied non-dry-run prior escalates the ladder", async () => {
    const seasonStart = new Date(openedAt.getTime() - 1_000_000);
    await seedSeason(db, serverId, seasonStart);
    await db.insert(bans).values({
      serverId, dayzId: OFFENDER_1, gamertag: "Offender1",
      bannedAt: new Date(openedAt.getTime() - 400_000),
      expiresAt: new Date(openedAt.getTime() + 86_400_000),
      status: "applied", dryRun: false,
    });

    const id = await seedIncident();
    await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
    const rows = await db.select().from(bans).where(eq(bans.dayzId, OFFENDER_1));
    const newBan = rows.find((b) => b.incidentId === id)!;
    const damage: IncidentDamage = { partsDismantled: 4, partsBuilt: 0, stackItems: 0, hasBreach: false, hasGate: false };
    expect(newBan.expiresAt!.getTime() - newBan.bannedAt.getTime()).toBe(sentenceMsFor(damage, 1));
  });

  // MINOR regression: `banned` must count rows actually INSERTED, not
  // participants iterated — a retried report on an incident where one
  // participant is already banned (onConflictDoNothing) must not claim it
  // banned that participant again.
  it("banned counts inserted rows, not participants, when one is already banned", async () => {
    const id = await seedIncident();
    await db.insert(bans).values({
      serverId, incidentId: id, dayzId: OFFENDER_1, gamertag: "Offender1",
      bannedAt: now, expiresAt: null, status: "pending",
    });
    // reportIncidentDb itself refuses a second report on the SAME incident,
    // so simulate the only way this onConflict path is reachable: the report
    // write racing a hand-seeded row under the same (incidentId, dayzId).
    await db.update(zoneIncidents).set({ reportedAt: null }).where(eq(zoneIncidents.id, id));
    const r = await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
    expect(r).toEqual({ ok: true, banned: 1 });
  });

  // Per-participant charging (spec §2.4, §7 amended): the owner picks WHO
  // to charge among the incident's own participants, not merely whether to
  // report at all. This is the escape hatch a raid-in-progress needs — a
  // raider and an invited helper folded into the same incident can now be
  // charged separately.
  describe("per-participant charging", () => {
    it("charging one of two participants bans only that one, on the incident's full damage total", async () => {
      const id = await seedIncident();
      const r = await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1]);
      expect(r).toEqual({ ok: true, banned: 1 });
      const rows = await db.select().from(bans);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dayzId: OFFENDER_1, gamertag: "Offender1" });
      const damage: IncidentDamage = { partsDismantled: 4, partsBuilt: 0, stackItems: 0, hasBreach: false, hasGate: false };
      expect(rows[0]!.expiresAt!.getTime() - rows[0]!.bannedAt.getTime()).toBe(sentenceMsFor(damage, 0));
    });

    it("charging both participants still bans both for the SAME (full-total) term as charging one", async () => {
      const id = await seedIncident();
      await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, OFFENDER_2]);
      const rows = await db.select().from(bans);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((b) => b.expiresAt!.getTime())).size).toBe(1);
    });

    it("an id that was not a participant on THIS incident is refused, and stamps nothing", async () => {
      const id = await seedIncident();
      const NOT_A_PARTICIPANT = "N".repeat(40);
      expect(await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1, NOT_A_PARTICIPANT]))
        .toEqual({ ok: false, reason: "not-participant" });
      expect(await db.select().from(bans)).toHaveLength(0);
      // Refused, not reported: the incident must still be reportable afterwards.
      const [row] = await db.select({ reportedAt: zoneIncidents.reportedAt }).from(zoneIncidents).where(eq(zoneIncidents.id, id));
      expect(row!.reportedAt).toBeNull();
    });

    it("an empty selection is refused, and stamps nothing", async () => {
      const id = await seedIncident();
      expect(await reportIncidentDb(db, now, OFFICER_DISCORD, id, [])).toEqual({ ok: false, reason: "no-selection" });
      expect(await db.select().from(bans)).toHaveLength(0);
      const [row] = await db.select({ reportedAt: zoneIncidents.reportedAt }).from(zoneIncidents).where(eq(zoneIncidents.id, id));
      expect(row!.reportedAt).toBeNull();
    });

    it("charging one participant still marks the incident reported, refusing a later report naming the other", async () => {
      const id = await seedIncident();
      expect(await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_1])).toEqual({ ok: true, banned: 1 });
      expect(await reportIncidentDb(db, now, OFFICER_DISCORD, id, [OFFENDER_2]))
        .toEqual({ ok: false, reason: "already-reported" });
      const rows = await db.select().from(bans);
      expect(rows.map((b) => b.dayzId)).toEqual([OFFENDER_1]);
    });
  });
});
