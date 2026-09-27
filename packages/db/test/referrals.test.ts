import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, referrals, type Database } from "../src/index.js";

const URL = requireTestDatabaseUrl();

async function insertReferral(db: Database, { referred, referrer }: { referred: string; referrer: string }) {
  return db.insert(referrals).values({
    referredDiscordId: referred,
    referrerDiscordId: referrer,
    referrerDayzId: "uid-" + referrer,
    source: "later_bot",
  });
}

describe("referrals", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // ⚠️ Not truncated with `restart identity cascade` alongside other tables:
    // the permanence trigger rejects TRUNCATE. Disable it for this cleanup only.
    // ⚠️ Qualifications first: they FK-reference `referrals`, so a leftover
    // qualification row (this file's own prior test, or another suite sharing
    // this per-package database) would otherwise block deleting `referrals`.
    await db.execute(sql`ALTER TABLE referral_qualifications DISABLE TRIGGER USER`);
    await db.execute(sql`DELETE FROM referral_qualifications`);
    await db.execute(sql`ALTER TABLE referral_qualifications ENABLE TRIGGER USER`);
    await db.execute(sql`ALTER TABLE referrals DISABLE TRIGGER USER`);
    await db.execute(sql`DELETE FROM referrals`);
    await db.execute(sql`ALTER TABLE referrals ENABLE TRIGGER USER`);
  });

  it("rejects a delete", async () => {
    await insertReferral(db, { referred: "A", referrer: "B" });
    await expect(db.execute(sql`DELETE FROM referrals WHERE referred_discord_id = 'A'`)).rejects.toThrow(/permanent/);
  });

  it("rejects changing the referrer", async () => {
    await insertReferral(db, { referred: "A", referrer: "B" });
    await expect(db.execute(sql`UPDATE referrals SET referrer_discord_id = 'C' WHERE referred_discord_id = 'A'`)).rejects.toThrow(/permanent/);
  });

  it("allows marking the referrer notified once, and never again", async () => {
    await insertReferral(db, { referred: "A", referrer: "B" });
    await db.execute(sql`UPDATE referrals SET referrer_notified_at = now() WHERE referred_discord_id = 'A'`);
    await expect(db.execute(sql`UPDATE referrals SET referrer_notified_at = now() + interval '1 day' WHERE referred_discord_id = 'A'`)).rejects.toThrow(/permanent/);
  });

  it("rejects self-referral and a second referrer", async () => {
    await expect(insertReferral(db, { referred: "A", referrer: "A" })).rejects.toThrow(/referrals_not_self/);
    await insertReferral(db, { referred: "A", referrer: "B" });
    await expect(insertReferral(db, { referred: "A", referrer: "C" })).rejects.toThrow(/duplicate key/);
  });

  it("rejects truncate", async () => {
    // ⚠️ Since `referral_qualifications` FK-references `referrals` (migration
    // 0056), Postgres refuses this at the foreign-key level before our own
    // `referrals_no_truncate` trigger ever fires — a structural refusal, not
    // a data-dependent one, and just as permanent a block.
    await expect(db.execute(sql`TRUNCATE referrals`)).rejects.toThrow(/foreign key constraint/);
  });
});
