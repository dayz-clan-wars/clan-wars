import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, players, poles, events, admFiles, verificationChallenges, challengeAttempts, declarations,
  type Database,
} from "@factions/db";
import { LINK_TTL_MS, LINK_EMOTES, RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { declareSolo } from "@factions/declarations";
import { sql, eq } from "drizzle-orm";
import { linkStatusDb, startLinkDb, cancelLinkDb, unlinkDb, searchGamertagsDb } from "../src/link";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const UID_A = "A".repeat(40);
const P = "5000.00:100.00:5000.00";

describe("roster link writes", () => {
  let db: Database; let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table challenge_attempts, verification_challenges, declarations, poles, faction_members, factions, identity_links, players, events, raw_lines, adm_files, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(players).values({ dayzId: UID_A, gamertag: "Ronald", firstSeenAt: now, lastSeenAt: now });
  });

  const start = (discordId = "d1", extra: { newSequence?: boolean } = {}) =>
    startLinkDb(db, { discordId, targetDayzId: UID_A, now, rng: Math.random, ...extra });

  it("startLink issues the site's challenge: no channel, LINK_TTL_MS, LINK_EMOTES steps", async () => {
    const out = await start();
    expect(out.kind).toBe("issued");
    if (out.kind !== "issued") return;
    expect(out.challenge.guildId).toBeNull();
    expect(out.challenge.channelId).toBeNull();
    expect(out.challenge.expiresAt.getTime()).toBe(now.getTime() + LINK_TTL_MS);
    expect(out.challenge.sequence).toHaveLength(LINK_EMOTES);
  });

  it("linkStatus shows the open challenge with labelled steps and the server's confirmed count", async () => {
    const out = await start();
    if (out.kind !== "issued") throw new Error(out.kind);
    await db.insert(challengeAttempts).values({ challengeId: out.challenge.id, dayzId: UID_A, progressIndex: 2, lastMatchedEventId: 1, seenCount: 2 });
    const s = await linkStatusDb(db, "d1", now);
    expect(s.link).toBeNull();
    expect(s.ended).toBeNull();
    expect(s.challenge).toMatchObject({ id: out.challenge.id, targetDayzId: UID_A, gamertag: "Ronald", confirmed: 2, drawsLeft: 2 });
    expect(s.challenge!.steps.map((x) => x.confirmed)).toEqual([true, true, false]);
    expect(s.challenge!.steps[0]!.label).not.toMatch(/^Emote/u);
  });

  it("linkStatus reports how the last challenge ended: expired, or the cancel reason", async () => {
    const out = await start();
    if (out.kind !== "issued") throw new Error(out.kind);
    const late = new Date(now.getTime() + LINK_TTL_MS + 1);
    expect((await linkStatusDb(db, "d1", late))).toMatchObject({ challenge: null, ended: "expired" });
    await db.update(verificationChallenges).set({ canceledAt: late, cancelReason: "budget-exhausted" }).where(eq(verificationChallenges.id, out.challenge.id));
    expect((await linkStatusDb(db, "d1", late))).toMatchObject({ challenge: null, ended: "budget-exhausted" });
  });

  it("a switch-cancel is not reported as an ending — the player did it", async () => {
    const out = await start();
    if (out.kind !== "issued") throw new Error(out.kind);
    expect(await cancelLinkDb(db, "d1", now)).toEqual({ canceled: true });
    expect((await linkStatusDb(db, "d1", now))).toMatchObject({ challenge: null, ended: null });
    expect(await cancelLinkDb(db, "d1", now)).toEqual({ canceled: false });
  });

  it("searchGamertags offers unclaimed prefix matches only", async () => {
    expect(await searchGamertagsDb(db, "ron")).toEqual([{ dayzId: UID_A, gamertag: "Ronald" }]);
    await db.insert(identityLinks).values({ discordId: "d9", dayzId: UID_A, gamertag: "Ronald", verifiedAt: now });
    expect(await searchGamertagsDb(db, "ron")).toEqual([]);
    expect(await searchGamertagsDb(db, "   ")).toEqual([]);
  });

  describe("unlink", () => {
    beforeEach(async () => {
      await db.insert(identityLinks).values({ discordId: "d1", dayzId: UID_A, gamertag: "Ronald", verifiedAt: now });
    });

    it("refuses while a roster row exists, naming the clan", async () => {
      const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
      await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: UID_A, discordId: "d1", role: "leader", joinedAt: now });
      expect(await unlinkDb(db, "d1", now)).toEqual({ ok: false, reason: "in-clan", clanName: "Bears" });
      expect(await db.select().from(identityLinks)).toHaveLength(1);
    });

    it("releases a solo declaration and stamps the pole's grace, in the same transaction", async () => {
      const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
      await db.insert(poles).values({ serverId, map: "livonia", poleKey: P, x: "5000.00", y: "100.00", z: "5000.00", currentTexture: "Flag_White", flagRaised: true, firstSeenAt: now, lastSeenAt: now, graceUntil: now });
      await db.insert(events).values({ serverId, admFileId: a!.id, lineIndex: 0, type: "flag.raised", occurredAt: now, payload: { dayzId: UID_A, gamertag: "Ronald", texture: "Flag_White", poleKey: P, pole: { x: 5000, y: 100, z: 5000 } } });
      expect(await declareSolo(db, { serverId, dayzId: UID_A, poleKey: P, at: now })).toMatchObject({ ok: true });

      expect(await unlinkDb(db, "d1", now)).toEqual({ ok: true, releasedBase: true });
      expect(await db.select().from(declarations)).toEqual([]);
      expect(await db.select().from(identityLinks)).toEqual([]);
      const [pole] = await db.select({ graceUntil: poles.graceUntil }).from(poles).where(eq(poles.poleKey, P));
      expect(pole!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);
    });

    it("a solo with no base unlinks with releasedBase false; unlinking twice reports not-linked", async () => {
      expect(await unlinkDb(db, "d1", now)).toEqual({ ok: true, releasedBase: false });
      expect(await unlinkDb(db, "d1", now)).toEqual({ ok: false, reason: "not-linked" });
    });
  });
});
