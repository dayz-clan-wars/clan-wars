import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, clearReferrals, referrals, referralQualifications, referralWeeks, type Database } from "../src/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-29T12:00:00Z");

describe("referral_qualifications", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table referral_week_winners, referral_weeks restart identity cascade`);
    await clearReferrals(db);
    await db.insert(referrals).values({ referredDiscordId: "A", referrerDiscordId: "B", referrerDayzId: "dz-B", source: "later_bot", createdAt: now });
    await db.insert(referralQualifications).values({ referredDiscordId: "A", referrerDiscordId: "B", qualifiedAt: now });
  });

  it("refuses update, delete and truncate", async () => {
    await expect(db.execute(sql`update referral_qualifications set qualified_at = now()`)).rejects.toThrow(/permanent/);
    await expect(db.execute(sql`delete from referral_qualifications`)).rejects.toThrow(/permanent/);
    await expect(db.execute(sql`truncate referral_qualifications`)).rejects.toThrow(/permanent/);
  });

  it("refuses a second qualification for the same referral", async () => {
    await expect(db.insert(referralQualifications).values({ referredDiscordId: "A", referrerDiscordId: "B", qualifiedAt: now })).rejects.toThrow();
  });

  it("clearReferrals clears qualifications before referrals", async () => {
    await clearReferrals(db);
    expect(await db.select().from(referralQualifications)).toEqual([]);
    expect(await db.select().from(referrals)).toEqual([]);
  });

  it("referral_weeks is keyed on week_start with an empty detail by default", async () => {
    const start = new Date("2026-09-21T10:00:00Z");
    await db.insert(referralWeeks).values({ weekStart: start, closedAt: now, topCount: 0 });
    const again = await db.insert(referralWeeks).values({ weekStart: start, closedAt: now, topCount: 0 }).onConflictDoNothing().returning();
    expect(again).toEqual([]);
    expect((await db.select().from(referralWeeks))[0]!.detail).toEqual({});
  });
});
