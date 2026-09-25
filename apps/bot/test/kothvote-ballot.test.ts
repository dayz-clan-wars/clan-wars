import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, kothVotes, kothVoteVoters, servers, type Database } from "@factions/db";
import { and, eq, sql } from "drizzle-orm";
import { castBallot } from "../src/commands/kothvote.js";
import { routeInteraction } from "../src/commands/route.js";
import { voteButtonId } from "../src/commands/confirm.js";
import type { Ctx } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-03T15:10:00Z");

describe("koth vote ballots", () => {
  let db: Database; let voteId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table koth_votes, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    const [v] = await db.insert(kothVotes).values({
      serverId: s!.id, slotAt: at("2026-10-03T16:00:00Z"), location: "borek", startedByDiscordId: "d0",
      openedAt: at("2026-10-03T15:00:00Z"), closesAt: at("2026-10-03T15:30:00Z"), electorateSize: 5, turnoutFloor: 5, state: "open",
    }).returning();
    voteId = v!.id;
    await db.insert(kothVoteVoters).values(["d0", "d1", "d2", "d3", "d4"].map((d) => ({ voteId, discordId: d, dayzId: `z${d}` })));
  });
  const ctx = (now = NOW) => ({ db, now, kothVote: null } as unknown as Ctx);
  const ballot = async (d: string) => (await db.select().from(kothVoteVoters)
    .where(and(eq(kothVoteVoters.voteId, voteId), eq(kothVoteVoters.discordId, d))))[0]!.ballot;

  it("counts an elector's ballot, and lets them change it", async () => {
    await castBallot(ctx(), { actorDiscordId: "d1", voteId, yes: true });
    expect(await ballot("d1")).toBe(true);
    await castBallot(ctx(), { actorDiscordId: "d1", voteId, yes: false });
    expect(await ballot("d1")).toBe(false);
  });
  it("refuses someone outside the frozen electorate", async () => {
    const r = await castBallot(ctx(), { actorDiscordId: "late", voteId, yes: true });
    expect(r.content).toMatch(/when this vote opened/);
  });
  // Review focus 1.
  it("refuses a ballot at or after closes_at even while still open", async () => {
    const r = await castBallot(ctx(at("2026-10-03T15:30:00Z")), { actorDiscordId: "d1", voteId, yes: true });
    expect(r.content).toMatch(/closed/);
    expect(await ballot("d1")).toBeNull();
  });

  it("routes a vote button to the ballot, ephemerally, for any presser", async () => {
    const editReply = vi.fn(async () => {});
    const i = {
      isAutocomplete: () => false, isChatInputCommand: () => false, isModalSubmit: () => false,
      isMessageComponent: () => true, isStringSelectMenu: () => false,
      customId: voteButtonId(voteId, true), user: { id: "d2" },
      deferReply: vi.fn(async () => {}), editReply,
    };
    expect(await routeInteraction(ctx(), i as never)).toBe(true);
    expect(i.deferReply).toHaveBeenCalledWith({ flags: expect.anything() });
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/Counted: Yes/) }));
    expect(await ballot("d2")).toBe(true);
  });
});
