import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl, clearReferrals,
  servers, admFiles, events, playerSessions, identityLinks, referrals, referralQualifications, type Database,
} from "@factions/db";
import { qualifyReferralsDb } from "../src/internal/referral-qualify";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);

describe("qualifyReferralsDb", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table player_sessions, events, adm_files, identity_links, servers restart identity cascade`);
    await clearReferrals(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at("2026-01-01T00:00:00Z"), linesIngested: 0, complete: true }).returning();
    fileId = f!.id; line = 0;
  });

  const link = (discordId: string, dayzId: string) =>
    db.insert(identityLinks).values({ discordId, dayzId, gamertag: `gt-${dayzId}`, verifiedAt: at("2026-01-01T00:00:00Z") });
  const refer = (referred: string, referrer: string, createdAt: string) =>
    db.insert(referrals).values({ referredDiscordId: referred, referrerDiscordId: referrer, referrerDayzId: `dz-${referrer}`, source: "later_bot", createdAt: at(createdAt) });
  async function session(dayzId: string, from: string, to: string | null) {
    const [e] = await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.connected", occurredAt: at(from), payload: { dayzId } }).returning();
    await db.insert(playerSessions).values({ serverId, dayzId, connectedAt: at(from), connectEventId: e!.id,
      disconnectedAt: to === null ? null : at(to), closeReason: to === null ? null : "disconnect" });
  }
  const quals = () => db.select().from(referralQualifications);

  it("records a referral once the referred player passes two hours, at that instant", async () => {
    await link("A", "dz-A"); await link("B", "dz-B");
    await refer("A", "B", "2026-09-28T12:00:00Z");
    await session("dz-A", "2026-09-29T10:00:00Z", "2026-09-29T11:00:00Z");
    expect(await qualifyReferralsDb(db, at("2026-09-29T12:00:00Z"))).toBe(0);
    await session("dz-A", "2026-09-30T10:00:00Z", "2026-09-30T12:00:00Z");
    expect(await qualifyReferralsDb(db, at("2026-09-30T13:00:00Z"))).toBe(1);
    expect(await quals()).toEqual([expect.objectContaining({ referredDiscordId: "A", referrerDiscordId: "B", qualifiedAt: at("2026-09-30T11:00:00Z") })]);
  });

  it("uses the referral instant for a player who already had the play time", async () => {
    await link("A", "dz-A"); await link("B", "dz-B");
    await session("dz-A", "2026-01-02T00:00:00Z", "2026-01-02T05:00:00Z");
    await refer("A", "B", "2026-09-28T12:00:00Z");
    await qualifyReferralsDb(db, at("2026-09-28T12:05:00Z"));
    expect((await quals())[0]!.qualifiedAt).toEqual(at("2026-09-28T12:00:00Z"));
  });

  it("writes nothing twice, and keeps the qualification after the referred player unlinks", async () => {
    await link("A", "dz-A"); await link("B", "dz-B");
    await refer("A", "B", "2026-09-28T12:00:00Z");
    await session("dz-A", "2026-09-29T10:00:00Z", "2026-09-29T13:00:00Z");
    expect(await qualifyReferralsDb(db, at("2026-09-29T14:00:00Z"))).toBe(1);
    await db.delete(identityLinks).where(sql`discord_id = 'A'`);
    expect(await qualifyReferralsDb(db, at("2026-09-29T15:00:00Z"))).toBe(0);
    expect(await quals()).toHaveLength(1);
  });

  it("skips a referred player who is not linked", async () => {
    await link("B", "dz-B");
    await refer("A", "B", "2026-09-28T12:00:00Z");
    await session("dz-A", "2026-09-29T10:00:00Z", "2026-09-29T13:00:00Z");
    expect(await qualifyReferralsDb(db, at("2026-09-29T14:00:00Z"))).toBe(0);
  });
});
