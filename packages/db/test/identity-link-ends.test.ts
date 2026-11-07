import { describe, it, expect, beforeEach } from "vitest";
import { sql, eq } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, identityLinkEnds, bans, servers, type Database } from "../src/index.js";

const URL = requireTestDatabaseUrl();

describe("identity_link_ends", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`DELETE FROM identity_link_ends`);
    await db.execute(sql`DELETE FROM identity_links WHERE dayz_id IN ('D1','D2')`);
  });

  const link = (discordId: string, dayzId: string) =>
    db.insert(identityLinks).values({ discordId, dayzId, gamertag: "G" + dayzId, verifiedAt: new Date() });

  it("records a deleted link", async () => {
    await link("U1", "D1");
    await db.delete(identityLinks).where(eq(identityLinks.dayzId, "D1"));
    const rows = await db.select().from(identityLinkEnds);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dayzId: "D1", discordId: "U1" });
    expect(rows[0]!.endedAt).toBeInstanceOf(Date);
  });

  it("records a delete by discord_id", async () => {
    await link("U2", "D2");
    await db.execute(sql`DELETE FROM identity_links WHERE discord_id = 'U2'`);
    const rows = await db.select().from(identityLinkEnds);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dayzId: "D2", discordId: "U2" });
  });

  it("records nothing for an insert", async () => {
    await link("U1", "D1");
    expect(await db.select().from(identityLinkEnds)).toHaveLength(0);
  });

  it("round-trips bans.nitrado_added", async () => {
    const [srv] = await db.select().from(servers).limit(1);
    let serverId = srv?.id;
    if (serverId === undefined) {
      const [s] = await db.insert(servers).values({ name: "t-link-ends" } as never).returning();
      serverId = s!.id;
    }
    const base = { serverId, gamertag: "G", bannedAt: new Date(), status: "applied" as const, reason: "unlinked" as const };
    const [a] = await db.insert(bans).values({ ...base, dayzId: "NA-A", nitradoAdded: ["A", "B"] }).returning();
    const [b] = await db.insert(bans).values({ ...base, dayzId: "NA-B" }).returning();
    expect(a!.nitradoAdded).toEqual(["A", "B"]);
    expect(b!.nitradoAdded).toBeNull();
    await db.execute(sql`DELETE FROM bans WHERE dayz_id IN ('NA-A','NA-B')`);
  });
});
