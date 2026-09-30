import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, awardGrants, awardTransfers, clanNotices, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { awardGroup } from "../src/commands/award.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const NOW = new Date("2026-09-22T12:00:00Z");
const spec = (p: string) => awardGroup.specs.find((s) => s.path === p)!;

describe("/award", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table award_transfers, award_grants, clan_notices, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true });
  });

  const ctx = () => ({ db, now: NOW, serverEvents: null, bountiesEnabled: false, koth: null, kothVote: null, roster: {} as never, siteBaseUrl: "https://dayzclanwars.com" }) as unknown as Ctx;
  const input = (o: { isAdmin?: boolean; user?: string | null; award?: string; reason?: string; grant?: string; days?: number } = {}) => ({
    actorDiscordId: "9", isAdmin: o.isAdmin ?? true,
    string: (n: string) => (n === "award" ? o.award ?? "plate-carrier" : n === "reason" ? o.reason ?? "Winner, Sept KOTH" : n === "grant" ? o.grant ?? null : null),
    integer: (n: string) => (n === "days" ? o.days ?? null : null), boolean: () => null,
    user: (n: string) => (n === "user" ? (o.user === undefined ? "1" : o.user) : null),
  }) as unknown as CommandInput;

  it("grants, queues the DM, and answers ephemerally", async () => {
    const r = await spec("award grant").handler(ctx(), input());
    expect(r.ephemeral).toBe(true);
    expect(r.content).toMatch(/Plate Carrier/);
    expect(await db.select().from(awardGrants)).toHaveLength(1);
    expect((await db.select().from(clanNotices))[0]!.kind).toBe("award_granted");
  });

  it("⚠️ refuses a non-admin on every subcommand and writes nothing", async () => {
    for (const p of ["award grant", "award revoke", "award list"]) {
      const r = await spec(p).handler(ctx(), input({ isAdmin: false, grant: "1" }));
      expect(r.content, p).toMatch(/admin/i);
    }
    expect(await db.select().from(awardGrants)).toEqual([]);
  });

  it("grants for the admin's days, and says how long in the reply", async () => {
    const r = await spec("award grant").handler(ctx(), input({ days: 3 }));
    expect(r.content).toMatch(/for 3 days once it spawns/);
    expect((await db.select().from(awardGrants))[0]!.durationDays).toBe(3);
  });

  it("without days, grants for the award's own length", async () => {
    const r = await spec("award grant").handler(ctx(), input({ award: "booster-kit" }));
    expect(r.content).toMatch(/Booster Kit.*for 7 days/);
    expect((await db.select().from(awardGrants))[0]!.durationDays).toBe(7);
  });

  it("refuses days out of range, and writes nothing", async () => {
    const r = await spec("award grant").handler(ctx(), input({ days: 91 }));
    expect(r.content).toMatch(/1 to 90/);
    expect(await db.select().from(awardGrants)).toEqual([]);
  });

  it("⚠️ keeps the list under Discord's 2000 characters, cutting whole lines", async () => {
    for (let i = 0; i < 25; i++) {
      await spec("award grant").handler(ctx(), input({ user: "123456789012345678" + (i % 10), days: 90 }));
    }
    const content = (await spec("award list").handler(ctx(), input({ user: null }))).content ?? "";
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toMatch(/and \d+ more/);
    for (const line of content.split("\n").slice(0, -1)) expect(line).toMatch(/^#\d+ Plate Carrier \(90 days\): <@\d+>, not placed yet \(place by <t:\d+:f>\)$/);
  });

  it("refuses an unknown award key", async () => {
    const r = await spec("award grant").handler(ctx(), input({ award: "golden-shovel" }));
    expect(r.content).toMatch(/not an award/i);
  });

  it("revokes by id, and says so", async () => {
    await spec("award grant").handler(ctx(), input());
    const [g] = await db.select().from(awardGrants);
    const r = await spec("award revoke").handler(ctx(), input({ grant: String(g!.id) }));
    expect(r.content).toMatch(/revoked/i);
    expect((await db.select().from(awardGrants))[0]!.revokedAt).toEqual(NOW);
  });

  it("revoke refuses an id that is not a number", async () => {
    const r = await spec("award revoke").handler(ctx(), input({ grant: "abc" }));
    expect(r.content).toMatch(/pick a grant/i);
  });

  it("lists open grants", async () => {
    await spec("award grant").handler(ctx(), input());
    const r = await spec("award list").handler(ctx(), input({ user: null }));
    expect(r.content).toMatch(/#\d+ Plate Carrier/);
    expect(r.content).toMatch(/<@1>/);
  });

  it("list names who gave an award away", async () => {
    await spec("award grant").handler(ctx(), input());
    const [g] = await db.select().from(awardGrants);
    await db.insert(awardTransfers).values({ awardGrantId: g!.id, fromDiscordId: "7", toDiscordId: "1", transferredAt: NOW, remainingMs: 1 });
    const r = await spec("award list").handler(ctx(), input({ user: null }));
    expect(r.content).toContain("given by <@7>");
  });

  it("list says so when there is nothing open", async () => {
    const r = await spec("award list").handler(ctx(), input({ user: null }));
    expect(r.content).toMatch(/no open awards/i);
  });

  it("revoke's autocomplete names each open grant", async () => {
    await spec("award grant").handler(ctx(), input());
    const choices = await spec("award revoke").autocomplete!.grant!(ctx(), { actorDiscordId: "9", value: "" });
    expect(choices).toHaveLength(1);
    expect(choices[0]!.name).toMatch(/^#\d+ Plate Carrier/);
  });
});
