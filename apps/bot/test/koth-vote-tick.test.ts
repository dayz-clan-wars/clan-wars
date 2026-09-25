import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, identityLinks, kothEvents, kothVotes, kothVoteVoters, servers, type Database,
} from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { kothVoteTick } from "../src/koth-vote-tick.js";
import type { KothVoteChannel } from "../src/koth-vote-channel.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T16:00:00Z");
const CLOSE = at("2026-10-03T15:30:00Z");

describe("kothVoteTick", () => {
  let db: Database; let serverId = 0; let voteId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table koth_votes, koth_events, airdrop_events, identity_links, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
    await db.insert(identityLinks).values({ discordId: "d0", dayzId: "z0", gamertag: "Mina", verifiedAt: CLOSE });
    const [v] = await db.insert(kothVotes).values({
      serverId, slotAt: SLOT, location: "borek", startedByDiscordId: "d0", openedAt: at("2026-10-03T15:00:00Z"),
      closesAt: CLOSE, electorateSize: 6, turnoutFloor: 5, state: "open", channelId: "c1", messageId: "m1", tallyText: "old",
    }).returning();
    voteId = v!.id;
    await db.insert(kothVoteVoters).values(["d0", "d1", "d2", "d3", "d4", "d5"].map((d) => ({ voteId, discordId: d, dayzId: `z${d}` })));
  });

  const vote = async () => (await db.select().from(kothVotes).where(eq(kothVotes.id, voteId)))[0]!;
  const cast = (d: string, yes: boolean) => db.update(kothVoteVoters).set({ ballot: yes, castAt: at("2026-10-03T15:05:00Z") })
    .where(sql`${kothVoteVoters.voteId} = ${voteId} and ${kothVoteVoters.discordId} = ${d}`);
  const channel = () => ({ post: vi.fn(), edit: vi.fn(async () => {}) }) as unknown as KothVoteChannel & { edit: ReturnType<typeof vi.fn> };
  const run = (ch: KothVoteChannel, announce: (c: string) => Promise<void>, now: Date, enabled = true) =>
    kothVoteTick(db, ch, announce, { now, enabled });

  it("edits the tally when it changes, and stores it", async () => {
    await cast("d0", true);
    const ch = channel();
    expect((await run(ch, vi.fn(async () => {}), at("2026-10-03T15:10:00Z"))).edited).toBe(1);
    expect(ch.edit).toHaveBeenCalledWith("c1", "m1", expect.stringContaining("Yes 1 · No 0"), voteId);
    expect((await vote()).tallyText).toContain("Yes 1 · No 0");
  });
  // Review focus 4.
  it("does not edit when the tally is unchanged", async () => {
    await cast("d0", true);
    await run(channel(), vi.fn(async () => {}), at("2026-10-03T15:10:00Z"));
    const ch = channel();
    expect((await run(ch, vi.fn(async () => {}), at("2026-10-03T15:11:00Z"))).edited).toBe(0);
    expect(ch.edit).not.toHaveBeenCalled();
  });

  it("passes: inserts the event, announces it, stamps it, and closes the message", async () => {
    for (const d of ["d0", "d1", "d2", "d3"]) await cast(d, true);
    await cast("d4", false);
    const ch = channel(); const announce = vi.fn(async (_c: string) => {});
    await run(ch, announce, CLOSE);
    const v = await vote();
    expect(v.state).toBe("passed");
    const [ev] = await db.select().from(kothEvents);
    expect(ev).toMatchObject({ id: v.kothEventId, origin: "vote", scheduledByDiscordId: "d0", slotAt: SLOT, location: "borek", awardKey: null, state: "scheduled" });
    expect(ev!.announcedAt).toEqual(CLOSE);
    expect(ev!.remindedAt).toEqual(CLOSE);
    expect(announce.mock.calls[0]![0]).toContain("The vote passed (Yes 4 · No 1)");
    expect(v.resultPostedAt).toEqual(CLOSE);
    expect(ch.edit).toHaveBeenLastCalledWith("c1", "m1", expect.stringContaining("Voting has closed"), null);
  });
  // Review focus 2.
  it("passes when closed late but before the slot", async () => {
    for (const d of ["d0", "d1", "d2", "d3", "d4"]) await cast(d, true);
    await run(channel(), vi.fn(async () => {}), at("2026-10-03T15:35:00Z"));
    expect((await vote()).state).toBe("passed");
  });
  it("fails on turnout", async () => {
    for (const d of ["d0", "d1", "d2", "d3"]) await cast(d, true);
    const announce = vi.fn(async (_c: string) => {});
    await run(channel(), announce, CLOSE);
    expect((await vote()).state).toBe("failed");
    expect(await db.select().from(kothEvents)).toHaveLength(0);
    expect(announce.mock.calls[0]![0]).toMatch(/4 of the 5 votes/);
  });
  it("fails on the majority", async () => {
    for (const d of ["d0", "d1", "d2"]) await cast(d, true);
    for (const d of ["d3", "d4"]) await cast(d, false);
    await run(channel(), vi.fn(async () => {}), CLOSE);
    expect((await vote()).state).toBe("failed");
  });
  it("voids at close if an admin scheduled in the meantime", async () => {
    for (const d of ["d0", "d1", "d2", "d3", "d4"]) await cast(d, true);
    await db.insert(kothEvents).values({ serverId, slotAt: at("2026-10-04T20:00:00Z"), location: "lembork", centreX: "1", centreZ: "1", state: "scheduled", origin: "admin", scheduledByDiscordId: "9", announcedAt: CLOSE });
    const announce = vi.fn(async (_c: string) => {});
    await run(channel(), announce, CLOSE);
    expect((await vote()).state).toBe("void");
    expect(announce.mock.calls[0]![0]).toMatch(/did not go ahead/);
  });
  it("voids a vote the bot reaches only after its slot", async () => {
    for (const d of ["d0", "d1", "d2", "d3", "d4"]) await cast(d, true);
    await run(channel(), vi.fn(async () => {}), at("2026-10-03T16:05:00Z"));
    expect((await vote()).state).toBe("void");
    expect(await db.select().from(kothEvents)).toHaveLength(0);
  });
  it("voids at close when voting was switched off", async () => {
    for (const d of ["d0", "d1", "d2", "d3", "d4"]) await cast(d, true);
    await run(channel(), vi.fn(async () => {}), CLOSE, false);
    expect((await vote()).state).toBe("void");
    expect((await vote()).detail).toMatchObject({ reason: "voting was switched off" });
  });
  it("retries a failed result post, and still records the close", async () => {
    for (const d of ["d0", "d1", "d2", "d3"]) await cast(d, true);
    await run(channel(), vi.fn(async () => { throw new Error("gone"); }), CLOSE);
    expect((await vote()).state).toBe("failed");
    expect((await vote()).resultPostedAt).toBeNull();
    const announce = vi.fn(async () => {});
    await run(channel(), announce, at("2026-10-03T15:31:00Z"));
    expect(announce).toHaveBeenCalledTimes(1);
    expect((await vote()).resultPostedAt).not.toBeNull();
  });
  it("still closes and posts when the message was deleted by hand", async () => {
    for (const d of ["d0", "d1", "d2", "d3"]) await cast(d, true);
    const ch = { post: vi.fn(), edit: vi.fn(async () => { throw new Error("Unknown Message"); }) } as unknown as KothVoteChannel;
    const announce = vi.fn(async () => {});
    await run(ch, announce, CLOSE);
    expect((await vote()).state).toBe("failed");
    expect(announce).toHaveBeenCalledTimes(1);
  });
});
