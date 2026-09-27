import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, clearReferrals,
  servers, players, identityLinks, verificationChallenges, referrals,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { addReferrerDb, referralsForDb, referralsForDayzIdDb } from "../src/referral";
import { linkStatusDb } from "../src/link";
import { startLinkDb } from "../src/link";
import { PgVerificationStore } from "@factions/verification";

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
    const out = await startLinkDb(db, { discordId: "A", targetDayzId: uid("T"), referrerGamertag: "Ronald", surface: "site", now, rng: Math.random });
    expect(out).toEqual({ kind: "referrer-refused", reason: "self" });
    expect(await db.select().from(verificationChallenges)).toEqual([]);
  });

  it("startLink with a good referrer saves it on the challenge", async () => {
    await link("B", uid("B"), "Otto");
    await seedPlayer(uid("T"), "Target");
    const out = await startLinkDb(db, { discordId: "A", targetDayzId: uid("T"), referrerGamertag: "Otto", surface: "site", now, rng: Math.random });
    expect(out.kind).toBe("issued");
    if (out.kind !== "issued") throw new Error(out.kind);
    expect(out.challenge.referrerDiscordId).toBe("B");
  });

  it.each([["bot", "link_bot"], ["site", "link_site"]] as const)(
    "startLink from the %s writes %s on the challenge, and completing it records that source",
    async (surface, source) => {
      await link("B", uid("B"), "Otto");
      await seedPlayer(uid("T"), "Target");
      const out = await startLinkDb(db, { discordId: "A", targetDayzId: uid("T"), referrerGamertag: "Otto", surface, now, rng: Math.random });
      if (out.kind !== "issued") throw new Error(out.kind);
      expect(out.challenge).toMatchObject({ guildId: null, referralSource: source });
      expect(await new PgVerificationStore(db).completeChallenge(out.challenge.id, uid("T"), "Target", now)).toBe(true);
      expect(await db.select().from(referrals)).toEqual([expect.objectContaining({ referredDiscordId: "A", referrerDiscordId: "B", source })]);
    },
  );

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

  it("an unlinked referrer shows the character named in THAT referral, not another referral's", async () => {
    await link("A", uid("A"), "Ronald");
    await link("C", uid("C"), "Carl");
    await link("B", uid("B"), "Otto");
    await seedPlayer(uid("B"), "Otto");
    await seedPlayer(uid("Q"), "Quinn");
    expect(await addReferrerDb(db, now, "A", "Otto", "later_bot")).toMatchObject({ kind: "recorded" });
    // B moves to another character, refers C from it, then unlinks.
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "B"));
    await link("B", uid("Q"), "Quinn");
    expect(await addReferrerDb(db, now, "C", "Quinn", "later_bot")).toMatchObject({ kind: "recorded" });
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "B"));

    expect((await referralsForDb(db, "A")).referredBy).toEqual({ gamertag: "Otto" });
    expect((await referralsForDb(db, "C")).referredBy).toEqual({ gamertag: "Quinn" });
  });

  it("an unlinked referrer with no known character has a null gamertag, never their Discord id", async () => {
    await link("A", uid("A"), "Ronald");
    await link("B", uid("B"), "Otto");
    expect(await addReferrerDb(db, now, "A", "Otto", "later_bot")).toMatchObject({ kind: "recorded" });
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "B"));

    expect((await referralsForDb(db, "A")).referredBy).toEqual({ gamertag: null });
    expect((await linkStatusDb(db, "A", now)).referredBy).toEqual({ gamertag: null });
    await link("D", uid("D"), "Dana");
    const again = await addReferrerDb(db, now, "A", "Dana", "later_bot");
    expect(again).toMatchObject({ kind: "refused", reason: "already-referred" });
    expect(JSON.stringify(again)).not.toContain('"B"');
  });

  it("referralsForDayzId resolves the profile's character, null when unlinked", async () => {
    await link("A", uid("A"), "Ronald");
    await link("B", uid("B"), "Otto");
    await seedPlayer(uid("Z"), "Zed");
    expect(await addReferrerDb(db, now, "A", "Otto", "later_bot")).toMatchObject({ kind: "recorded" });

    expect(await referralsForDayzIdDb(db, uid("A"))).toEqual({ referredBy: { gamertag: "Otto" }, brought: [] });
    expect(await referralsForDayzIdDb(db, uid("Z"))).toBeNull();
  });

  it("referralsForDayzId answers for a gamertag two links share case-insensitively, like the profile does", async () => {
    await link("A", uid("A"), "Ronald");
    await db.insert(identityLinks).values({ discordId: "R2", dayzId: uid("R"), gamertag: "ronald", verifiedAt: new Date(now.getTime() + 1000) });
    await link("B", uid("B"), "Otto");
    expect(await addReferrerDb(db, now, "R2", "Otto", "later_bot")).toMatchObject({ kind: "recorded" });

    expect(await referralsForDayzIdDb(db, uid("R"))).toEqual({ referredBy: { gamertag: "Otto" }, brought: [] });
    expect(await referralsForDayzIdDb(db, uid("A"))).toEqual({ referredBy: null, brought: [] });
  });
});
