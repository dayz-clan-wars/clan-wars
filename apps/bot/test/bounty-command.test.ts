import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, bounties, servers, players, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { SPECS } from "../src/commands/index.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const NOW = new Date("2026-09-23T12:00:00Z");
const T = "t1";
const handler = (p: string) => SPECS.get(p)!.handler;

describe("/bounty", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table bounties, players, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true });
    await db.insert(players).values({ dayzId: T, gamertag: "Target", firstSeenAt: NOW, lastSeenAt: NOW });
  });

  const ctx = (over: Partial<Ctx> = {}) => ({
    db, now: NOW, serverEvents: null, bountiesEnabled: true, roster: {} as never, siteBaseUrl: "https://dayzclanwars.com", ...over,
  }) as unknown as Ctx;

  const input = (o: {
    isAdmin?: boolean;
    strings?: Record<string, string | null>;
    integers?: Record<string, number | null>;
  } = {}) => ({
    actorDiscordId: "9",
    isAdmin: o.isAdmin ?? true,
    string: (n: string) => o.strings?.[n] ?? null,
    integer: (n: string) => o.integers?.[n] ?? null,
    boolean: () => null,
    user: () => null,
  }) as unknown as CommandInput;

  it("refuses a non-admin", async () => {
    const r = await handler("bounty place")(ctx(), input({ isAdmin: false, strings: { player: T, reason: "x" } }));
    expect(r.content).toMatch(/Only an admin/u);
  });

  it("refuses when BOUNTY_TICK is off, writing nothing", async () => {
    const r = await handler("bounty place")(ctx({ bountiesEnabled: false }), input({ isAdmin: true, strings: { player: T, reason: "x" } }));
    expect(r.content).toMatch(/Bounties are off/u);
    expect(await db.select().from(bounties)).toHaveLength(0);
  });

  it("places, then lists, then revokes", async () => {
    const placed = await handler("bounty place")(ctx(), input({ isAdmin: true, strings: { player: T, reason: "Combat logging" }, integers: { hours: 24 } }));
    expect(placed.content).toMatch(/Bounty #\d+ on \*\*Target\*\*/u);
    expect((await handler("bounty list")(ctx(), input({ isAdmin: true }))).content).toMatch(/Target/u);
    const [b] = await db.select().from(bounties);
    const revoked = await handler("bounty revoke")(ctx(), input({ isAdmin: true, strings: { bounty: String(b!.id) } }));
    expect(revoked.content).toMatch(/lifted/u);
  });

  it("says so when the player already has one open", async () => {
    await handler("bounty place")(ctx(), input({ isAdmin: true, strings: { player: T, reason: "x" } }));
    const r = await handler("bounty place")(ctx(), input({ isAdmin: true, strings: { player: T, reason: "x" } }));
    expect(r.content).toMatch(/already has an open bounty/u);
  });

  /**
   * ⚠️ 25 rows × up-to-200-char reasons can exceed Discord's 2,000-char reply limit.
   * `/bounty list` must truncate each reason and, if it still has to cut, say so
   * rather than let Discord silently reject an oversized reply.
   */
  it("⚠️ truncates long reasons and stays under Discord's 2,000-char reply limit", async () => {
    const [s] = await db.select().from(servers);
    const longReason = "x".repeat(200);
    for (let i = 0; i < 25; i++) {
      const dayzId = `bounty-target-${i}`;
      await db.insert(players).values({ dayzId, gamertag: `Target${i}`, firstSeenAt: NOW, lastSeenAt: NOW });
      await db.insert(bounties).values({
        serverId: s!.id, targetDayzId: dayzId, reason: longReason, placedByDiscordId: "9", placedAt: NOW,
        onlineBudgetMs: 3_600_000, deadlineAt: new Date(NOW.getTime() + 30 * 86_400_000), status: "open",
      });
    }
    const r = await handler("bounty list")(ctx(), input({ isAdmin: true }));
    expect(r.content!.length).toBeLessThanOrEqual(2000);
    expect(r.content).not.toContain(longReason);
    expect(r.content).toMatch(/…and \d+ more/u);
  });
});
