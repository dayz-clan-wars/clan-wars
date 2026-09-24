import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, awardGrants, clanNotices, servers, type Database } from "@factions/db";
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
    await db.execute(sql`truncate table award_grants, clan_notices, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true });
  });

  const ctx = () => ({ db, now: NOW, serverEvents: null, bountiesEnabled: false, koth: null, roster: {} as never, siteBaseUrl: "https://dayzclanwars.com" }) as unknown as Ctx;
  const input = (o: { isAdmin?: boolean; user?: string | null; award?: string; reason?: string; grant?: string } = {}) => ({
    actorDiscordId: "9", isAdmin: o.isAdmin ?? true,
    string: (n: string) => (n === "award" ? o.award ?? "plate-carrier" : n === "reason" ? o.reason ?? "Winner, Sept KOTH" : n === "grant" ? o.grant ?? null : null),
    integer: () => null, boolean: () => null,
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
