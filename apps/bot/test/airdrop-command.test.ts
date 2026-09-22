import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, airdropEvents, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { airdropGroup } from "../src/commands/airdrop.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-21T19:05:00Z");
const SLOT = at("2026-09-21T20:00:00Z");
const place = airdropGroup.specs.find((s) => s.path === "airdrop place")!.handler;

describe("/airdrop place", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table airdrop_events, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
  });

  const ctx = (post: ((c: string) => Promise<void>) | null = vi.fn(async () => {})) =>
    ({ db, now: NOW, serverEvents: post, roster: {} as never, siteBaseUrl: "https://x" }) as unknown as Ctx;
  const input = (over: Partial<CommandInput> & { location?: string; colour?: string | null } = {}) => ({
    actorDiscordId: "99", isAdmin: true,
    string: (n: string) => (n === "location" ? over.location ?? "dolnik" : over.colour ?? null),
    integer: () => null, boolean: () => null, user: () => null,
    ...over,
  }) as unknown as CommandInput;
  const rows = () => db.select().from(airdropEvents);

  it("places a drop at the next slot, announces it, and marks it manual", async () => {
    const post = vi.fn(async () => {});
    const reply = await place(ctx(post), input());
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toContain("Dolnik");
    const [row] = await rows();
    expect(row).toMatchObject({ slotAt: SLOT, location: "dolnik", state: "announced", manual: true });
    expect(row!.announcedAt).not.toBeNull();
    expect(post).toHaveBeenCalledWith(expect.stringContaining("DOLNIK"));
  });

  it("takes the colour when given one and rolls it when not", async () => {
    await place(ctx(), input({ colour: "yellow" }));
    expect((await rows())[0]!.colour).toBe("yellow");
  });

  // ⚠️ Defence in depth. The command JSON also carries
  // setDefaultMemberPermissions(ManageGuild), so Discord hides it — but a
  // permission overwrite on a channel can put it back, and placing loot on the
  // map is not something a member gets to do by finding a gap in a UI.
  it("refuses a non-admin and writes nothing", async () => {
    const reply = await place(ctx(), input({ isAdmin: false }));
    expect(reply.content).toMatch(/admin/i);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses a location that is not on the menu", async () => {
    const reply = await place(ctx(), input({ location: "narnia" }));
    expect(reply.content).toMatch(/not one of the/i);
    expect(await rows()).toHaveLength(0);
  });

  // ⚠️ Two drops at once is a state cfggameplay.json cannot hold: one element,
  // one spawner. The splice would refuse and the restart tick would scrub a drop
  // players had already been told about.
  it("refuses while another drop is announced or live", async () => {
    await db.insert(airdropEvents).values({
      serverId, slotAt: SLOT, location: "lukow", colour: "blue", decidedAt: NOW,
      popAtDecision: 4, threshold: "0", state: "announced", announcedAt: NOW,
    });
    const reply = await place(ctx(), input());
    expect(reply.content).toMatch(/already/i);
    expect(await rows()).toHaveLength(1);
  });

  // ⚠️ Spec §9 applies to a hand-placed drop too: nobody finds an unannounced one.
  it("places nothing when the announcement cannot post", async () => {
    const reply = await place(ctx(vi.fn(async () => { throw new Error("channel gone"); })), input());
    expect(reply.content).toMatch(/could not/i);
    expect((await rows())[0]!.state).toBe("failed");
  });

  it("refuses when the feature is switched off", async () => {
    const reply = await place(ctx(null), input());
    expect(reply.content).toMatch(/AIRDROP_TICK/);
    expect(await rows()).toHaveLength(0);
  });
});
