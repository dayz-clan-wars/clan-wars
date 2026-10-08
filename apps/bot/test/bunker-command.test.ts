import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, airdropEvents, kothEvents, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { bunkerGroup } from "../src/commands/bunker.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-21T19:05:00Z");
const SLOT = at("2026-09-21T20:00:00Z");
const place = bunkerGroup.specs.find((s) => s.path === "bunker place")!.handler;

describe("/bunker place", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table airdrop_events, koth_events, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "chernarusplus", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
  });

  const ctx = (post: ((c: string) => Promise<void>) | null = vi.fn(async () => {})) =>
    ({ db, now: NOW, serverEvents: post, bountiesEnabled: false, koth: null, kothVote: null, roster: {} as never, siteBaseUrl: "https://x" }) as unknown as Ctx;
  const input = (over: Partial<CommandInput> & { room?: string; kind?: string | null } = {}) => ({
    actorDiscordId: "99", isAdmin: true,
    string: (n: string) => (n === "room" ? over.room ?? "nwaf" : over.kind ?? null),
    integer: () => null, boolean: () => null, user: () => null,
    ...over,
  }) as unknown as CommandInput;
  const rows = () => db.select().from(airdropEvents);

  it("brings a bunker online at the next slot, announces it, and marks it manual", async () => {
    const post = vi.fn(async (_c: string) => {});
    const reply = await place(ctx(post), input({ kind: "boom" }));
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toMatch(/^Announced: \*\*NWAF\*\*, explosives\./);
    const [row] = await rows();
    expect(row).toMatchObject({ slotAt: SLOT, location: "nwaf", kind: "boom", colour: null, state: "announced", manual: true });
    expect(row!.announcedAt).not.toBeNull();
    expect(post).toHaveBeenCalledWith(expect.stringContaining("BUNKER ONLINE: NWAF"));
  });

  it("leaves the kind to chance when it is not given, and never says it", async () => {
    const post = vi.fn(async (_c: string) => {});
    await place(ctx(post), input());
    expect(["boom", "guns"]).toContain((await rows())[0]!.kind);
    expect(post.mock.calls[0]![0]).not.toMatch(/boom|guns|explosive/i);
  });

  it("refuses a kind outside the two", async () => {
    const reply = await place(ctx(), input({ kind: "nukes" }));
    expect(reply.content).toBe("nukes is not one of the two kinds.");
    expect(await rows()).toHaveLength(0);
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

  it("refuses a room that is not one of the 11", async () => {
    const reply = await place(ctx(), input({ room: "dolnik" }));
    expect(reply.content).toBe("dolnik is not one of the 11 bunker rooms.");
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
    expect(reply.content).toBe("A bunker is already announced or online. Only one at a time.");
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

  // ⚠️ Spec §2.12: one session cannot hold both events. The koth command has the
  // symmetric refusal on its own side.
  it("refuses a slot a scheduled King of the Hill event holds", async () => {
    await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "dolnik", centreX: "0", centreZ: "0",
      state: "scheduled", scheduledByDiscordId: "1", announcedAt: NOW,
    });
    const reply = await place(ctx(), input());
    expect(reply.content).toBe("King of the Hill holds that session. No bunker on top of it.");
    expect(await rows()).toHaveLength(0);
  });
});
