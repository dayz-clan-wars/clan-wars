import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, clearReferrals,
  servers, players, identityLinks, verificationChallenges, referrals,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { addReferrerDb, referralsForDb, referralsForGamertagDb } from "../src/referral";
import { startLinkDb } from "../src/link";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-26T12:00:00Z");
const uid = (s: string) => s.repeat(40).slice(0, 40);

describe("referral", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links, players, servers restart identity cascade`);
    });
    await clearReferrals(db);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 });
  });

  const link = (discordId: string, dayzId: string, gamertag: string) =>
    db.insert(identityLinks).values({ discordId, dayzId, gamertag, verifiedAt: now });
  const seedPlayer = (dayzId: string, gamertag: string) =>
    db.insert(players).values({ dayzId, gamertag, firstSeenAt: now, lastSeenAt: now });

  it("addReferrer resolves the gamertag case-insensitively and records it", async () => {
    await link("A", uid("A"), "Ronald");
    await link("B", uid("B"), "Otto");
    const out = await addReferrerDb(db, now, "A", "ottO", "later_bot");
    expect(out).toEqual({ kind: "recorded", referrerGamertag: "Otto" });
    const rows = await db.select().from(referrals);
    expect(rows).toEqual([expect.objectContaining({ referredDiscordId: "A", referrerDiscordId: "B" })]);
  });

  it("addReferrer refuses an unknown gamertag and an ambiguous one", async () => {
    await link("A", uid("A"), "Ronald");
    expect(await addReferrerDb(db, now, "A", "Nobody", "later_bot")).toEqual({ kind: "refused", reason: "unknown-referrer" });

    await link("B", uid("B"), "Dup");
    await link("C", uid("C"), "dup");
    expect(await addReferrerDb(db, now, "A", "DUP", "later_bot")).toEqual({ kind: "refused", reason: "ambiguous-referrer" });
  });

  it("addReferrer names the existing referrer when already referred", async () => {
    await link("A", uid("A"), "Ronald");
    await link("B", uid("B"), "Otto");
    await link("C", uid("C"), "Carl");
    expect(await addReferrerDb(db, now, "A", "Otto", "later_bot")).toEqual({ kind: "recorded", referrerGamertag: "Otto" });
    expect(await addReferrerDb(db, now, "A", "Carl", "later_bot")).toEqual({
      kind: "refused", reason: "already-referred", referrerGamertag: "Otto",
    });
  });

  it("startLink with a bad referrer refuses before issuing a challenge", async () => {
    await link("A", uid("A"), "Ronald");
    await seedPlayer(uid("T"), "Target");
    const out = await startLinkDb(db, { discordId: "A", targetDayzId: uid("T"), referrerGamertag: "Ronald", now, rng: Math.random });
    expect(out).toEqual({ kind: "referrer-refused", reason: "self" });
    expect(await db.select().from(verificationChallenges)).toEqual([]);
  });

  it("startLink with a good referrer saves it on the challenge", async () => {
    await link("B", uid("B"), "Otto");
    await seedPlayer(uid("T"), "Target");
    const out = await startLinkDb(db, { discordId: "A", targetDayzId: uid("T"), referrerGamertag: "Otto", now, rng: Math.random });
    expect(out.kind).toBe("issued");
    if (out.kind !== "issued") throw new Error(out.kind);
    expect(out.challenge.referrerDiscordId).toBe("B");
  });

  it("referralsFor shows the referrer by current gamertag, falling back to the player's last seen gamertag", async () => {
    await link("A", uid("A"), "Ronald");
    await link("B", uid("B"), "Otto");
    await seedPlayer(uid("B"), "Otto");
    expect(await addReferrerDb(db, now, "A", "Otto", "later_bot")).toMatchObject({ kind: "recorded" });

    expect((await referralsForDb(db, "A")).referredBy).toEqual({ gamertag: "Otto" });

    // B unlinks (identity_links row removed) but the referral survives, keyed
    // by discord id, and the display falls back to the player's last gamertag.
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "B"));
    expect((await referralsForDb(db, "A")).referredBy).toEqual({ gamertag: "Otto" });
  });

  it("referralsFor lists brought-in players, null gamertag for those unlinked", async () => {
    await link("A", uid("A"), "Ronald");
    await link("B", uid("B"), "Otto");
    await link("C", uid("C"), "Carl");
    expect(await addReferrerDb(db, now, "B", "Ronald", "later_bot")).toMatchObject({ kind: "recorded" });
    expect(await addReferrerDb(db, now, "C", "Ronald", "later_bot")).toMatchObject({ kind: "recorded" });

    await db.delete(identityLinks).where(eq(identityLinks.discordId, "C"));

    const { brought } = await referralsForDb(db, "A");
    expect(brought.sort((x, y) => (x.gamertag ?? "").localeCompare(y.gamertag ?? ""))).toEqual([
      { gamertag: null }, { gamertag: "Otto" },
    ]);
  });

  it("a referral survives unlink and relink", async () => {
    await link("A", uid("A"), "Ronald");
    await link("B", uid("B"), "Otto");
    expect(await addReferrerDb(db, now, "A", "Otto", "later_bot")).toMatchObject({ kind: "recorded" });

    await db.delete(identityLinks).where(eq(identityLinks.discordId, "A"));
    await link("A", uid("A"), "Ronald");

    expect((await referralsForDb(db, "A")).referredBy).toEqual({ gamertag: "Otto" });
    // Naming someone new is still refused after relinking.
    await link("D", uid("D"), "Dana");
    expect(await addReferrerDb(db, now, "A", "Dana", "later_bot")).toEqual({
      kind: "refused", reason: "already-referred", referrerGamertag: "Otto",
    });
  });

  it("referralsForGamertag resolves the profile's link, null when unlinked", async () => {
    await link("A", uid("A"), "Ronald");
    await link("B", uid("B"), "Otto");
    await seedPlayer(uid("Z"), "Zed");
    expect(await addReferrerDb(db, now, "A", "Otto", "later_bot")).toMatchObject({ kind: "recorded" });

    expect(await referralsForGamertagDb(db, "Ronald")).toEqual({ referredBy: { gamertag: "Otto" }, brought: [] });
    expect(await referralsForGamertagDb(db, "Zed")).toBeNull();
  });
});
