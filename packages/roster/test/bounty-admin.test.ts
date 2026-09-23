import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, bounties, clanNotices, identityLinks, players, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { placeBountyDb, revokeBountyDb, openBountiesDb, searchBountyTargetsDb } from "../src/internal/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-23T12:00:00Z");
const T = "T".repeat(40);
const H = 3_600_000;

describe("bounty administration", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table bounties, clan_notices, identity_links, players, player_sessions, servers restart identity cascade`);
    });
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true });
    await db.insert(players).values({ dayzId: T, gamertag: "Target", firstSeenAt: now, lastSeenAt: now });
  });
  const place = (over: Partial<Parameters<typeof placeBountyDb>[1]> = {}) =>
    placeBountyDb(db, { target: T, reason: "Combat logging", hours: null, adminDiscordId: "9", now, ...over });

  it("places a 72 h bounty with a 30-day deadline and no DM for an unlinked target", async () => {
    const out = await place();
    expect(out).toMatchObject({ ok: true, gamertag: "Target", budgetMs: 72 * H });
    const [b] = await db.select().from(bounties);
    expect(b).toMatchObject({ status: "open", onlineBudgetMs: 72 * H, deadlineAt: new Date("2026-10-23T12:00:00Z") });
    expect(await db.select().from(clanNotices)).toHaveLength(0);
  });

  it("DMs a linked target, with no coordinates in the payload", async () => {
    await db.insert(identityLinks).values({ discordId: "1", dayzId: T, gamertag: "Target", verifiedAt: now });
    await place({ hours: 24 });
    const [n] = await db.select().from(clanNotices);
    expect(n).toMatchObject({ kind: "bounty_placed", target: "dm", discordTargetId: "1" });
    expect(n!.payload).toEqual({ bountyId: expect.any(Number), reason: "Combat logging", hours: 24 });
  });

  it("refuses a second open bounty on the same player", async () => {
    await place();
    expect(await place()).toEqual({ ok: false, reason: "already-open" });
  });

  it("refuses a player the log has never seen", async () => {
    expect(await place({ target: "X".repeat(40) })).toEqual({ ok: false, reason: "unknown-player" });
  });

  it("⚠️ places a bounty on a gamertag typed out in full, in any case — Discord sends the raw text when no choice is picked", async () => {
    const out = await place({ target: "tARGET" });
    expect(out).toMatchObject({ ok: true, gamertag: "Target" });
    expect((await db.select().from(bounties))[0]!.targetDayzId).toBe(T);
  });

  it("refuses a typed gamertag two characters share, rather than guessing", async () => {
    await db.insert(players).values({ dayzId: "U".repeat(40), gamertag: "target", firstSeenAt: now, lastSeenAt: now });
    expect(await place({ target: "Target" })).toEqual({ ok: false, reason: "ambiguous-player" });
  });

  it("⚠️ autocomplete finds LINKED players too — /link's search excludes them, a bounty must not", async () => {
    const L = "L".repeat(40);
    await db.insert(players).values({ dayzId: L, gamertag: "Tarzan", firstSeenAt: now, lastSeenAt: new Date(now.getTime() + H) });
    await db.insert(identityLinks).values({ discordId: "1", dayzId: L, gamertag: "Tarzan", verifiedAt: now });
    expect(await searchBountyTargetsDb(db, "tar")).toEqual([
      { dayzId: L, gamertag: "Tarzan" }, { dayzId: T, gamertag: "Target" },
    ]);
    expect(await searchBountyTargetsDb(db, "  ")).toEqual([]);
    expect(await searchBountyTargetsDb(db, "%")).toEqual([]);
  });

  it("refuses hours outside 1..168, and an empty or overlong reason", async () => {
    expect(await place({ hours: 0 })).toEqual({ ok: false, reason: "bad-hours" });
    expect(await place({ hours: 169 })).toEqual({ ok: false, reason: "bad-hours" });
    expect(await place({ reason: "  " })).toEqual({ ok: false, reason: "no-reason" });
    expect(await place({ reason: "x".repeat(201) })).toEqual({ ok: false, reason: "reason-too-long" });
  });

  it("revokes an open bounty, and refuses one already closed", async () => {
    const out = await place();
    if (!out.ok) throw new Error("place failed");
    expect(await revokeBountyDb(db, { bountyId: out.bountyId, adminDiscordId: "9", now })).toEqual({ ok: true });
    const [b] = await db.select().from(bounties);
    expect(b).toMatchObject({ status: "revoked", revokedByDiscordId: "9", closedAt: now });
    expect(await revokeBountyDb(db, { bountyId: out.bountyId, adminDiscordId: "9", now })).toEqual({ ok: false, reason: "ended" });
    expect(await revokeBountyDb(db, { bountyId: 999, adminDiscordId: "9", now })).toEqual({ ok: false, reason: "not-found" });
  });

  it("lists open bounties with the time served so far", async () => {
    await place();
    const rows = await openBountiesDb(db, new Date(now.getTime() + H));
    expect(rows).toEqual([expect.objectContaining({ gamertag: "Target", budgetMs: 72 * H, servedMs: 0 })]);
  });
});
