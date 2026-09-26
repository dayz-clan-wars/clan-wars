import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, referrals, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { recordReferralTx, checkReferral } from "../src/referral";
import { clearReferrals } from "./clear-referrals";

const URL = requireTestDatabaseUrl();
const at = new Date("2026-09-26T12:00:00Z");

describe("referrals", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links, players restart identity cascade`);
    });
    await clearReferrals(db);
  });

  const link = (...ids: string[]) => db.insert(identityLinks).values(ids.map((d) => ({
    discordId: d, dayzId: `uid-${d}`.padEnd(40, "0"), gamertag: `gt-${d}`, verifiedAt: at,
  })));
  const record = (referredDiscordId: string, referrerDiscordId: string, source: "link_bot" | "link_site" | "later_bot" | "later_site" = "later_bot") =>
    db.transaction((tx) => recordReferralTx(tx, { referredDiscordId, referrerDiscordId, source, at }));
  const rows = () => db.select().from(referrals);

  it("records a referral between two linked players", async () => {
    await link("A", "B");
    expect(await record("A", "B", "later_site")).toBe("recorded");
    expect(await rows()).toEqual([expect.objectContaining({
      referredDiscordId: "A", referrerDiscordId: "B", referrerDayzId: "uid-B".padEnd(40, "0"),
      source: "later_site", referrerNotifiedAt: null,
    })]);
  });

  it("refuses a second referrer", async () => {
    await link("A", "B", "C");
    expect(await record("A", "B")).toBe("recorded");
    expect(await record("A", "C")).toBe("already-referred");
    expect(await rows()).toEqual([expect.objectContaining({ referredDiscordId: "A", referrerDiscordId: "B" })]);
  });

  it("refuses self", async () => {
    await link("A");
    expect(await record("A", "A")).toBe("self");
    expect(await rows()).toEqual([]);
  });

  it("refuses an unlinked referrer, and an unlinked referred player", async () => {
    await link("A");
    expect(await record("A", "B")).toBe("referrer-not-linked");
    expect(await record("C", "A")).toBe("not-linked");
    expect(await rows()).toEqual([]);
  });

  it("refuses a direct loop and a three-step loop", async () => {
    await link("A", "B", "C", "D", "E", "F");
    expect(await record("A", "B")).toBe("recorded");
    expect(await record("B", "A")).toBe("loop");
    expect(await record("D", "E")).toBe("recorded");
    expect(await record("E", "F")).toBe("recorded");
    expect(await record("F", "D")).toBe("loop");
    expect(await rows()).toHaveLength(3);
  });

  it("serialises concurrent opposite referrals: one wins, one is a loop", async () => {
    await link("A", "B");
    const [x, y] = await Promise.all([
      db.transaction((tx) => recordReferralTx(tx, { referredDiscordId: "A", referrerDiscordId: "B", source: "later_bot", at })),
      db.transaction((tx) => recordReferralTx(tx, { referredDiscordId: "B", referrerDiscordId: "A", source: "later_bot", at })),
    ]);
    expect([x, y].sort()).toEqual(["loop", "recorded"]);
    expect(await rows()).toHaveLength(1);
  });

  it("checkReferral refuses already-referred even while the player is unlinked", async () => {
    await link("A", "B", "C");
    expect(await record("A", "B")).toBe("recorded");
    // A unlinks: the referral outlives it, and naming someone new must still be refused.
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "A"));
    expect(await checkReferral(db, { referredDiscordId: "A", referrerDiscordId: "C" })).toBe("already-referred");
  });

  it("checkReferral passes an unlinked player naming a linked one, and names each refusal", async () => {
    await link("B", "C");
    expect(await checkReferral(db, { referredDiscordId: "Z", referrerDiscordId: "B" })).toBeNull();
    expect(await checkReferral(db, { referredDiscordId: "Z", referrerDiscordId: "Z" })).toBe("self");
    expect(await checkReferral(db, { referredDiscordId: "Z", referrerDiscordId: "Q" })).toBe("referrer-not-linked");
    expect(await record("C", "B")).toBe("recorded");
    expect(await checkReferral(db, { referredDiscordId: "B", referrerDiscordId: "C" })).toBe("loop");
  });
});
