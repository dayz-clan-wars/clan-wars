import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, admFiles, airdropEvents, events, identityLinks, kothEvents,
  kothVotes, kothVoteVoters, playerSessions, servers, type Database,
} from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { kothVoteGroup } from "../src/commands/kothvote.js";
import { parseVoteButtonId, voteButtonId } from "../src/commands/confirm.js";
import type { KothVoteChannel } from "../src/koth-vote-channel.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-03T15:00:00Z"); // targets the 16:00 slot, closes 15:30
const SLOT = at("2026-10-03T16:00:00Z");
const start = kothVoteGroup.specs.find((s) => s.path === "kothvote")!.handler;

describe("/kothvote", () => {
  let db: Database; let serverId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table koth_votes, koth_events, airdrop_events, identity_links, player_sessions, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id; line = 0;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at("2026-09-01T00:00:00Z"), linesIngested: 0, complete: true });
  });

  /** `linked` linked players d0…, plus `unlinked` strangers, all online now. */
  async function populate(linked: number, unlinked: number) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles);
    for (let i = 0; i < linked + unlinked; i++) {
      const dayzId = `z${i}`;
      const [e] = await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: at("2026-10-03T14:00:00Z"), payload: {} }).returning({ id: events.id });
      await db.insert(playerSessions).values({ serverId, dayzId, connectedAt: at("2026-10-03T14:00:00Z"), connectEventId: e!.id });
      if (i < linked) await db.insert(identityLinks).values({ discordId: `d${i}`, dayzId, gamertag: `Tag${i}`, verifiedAt: NOW });
    }
  }
  const channel = (): KothVoteChannel & { post: ReturnType<typeof vi.fn> } => ({
    post: vi.fn(async () => ({ channelId: "c1", messageId: "m1" })),
    edit: vi.fn(async () => {}),
  }) as never;
  const ctx = (ch: KothVoteChannel = channel(), enabled = true, now = NOW) =>
    ({ db, now, serverEvents: null, bountiesEnabled: false, koth: null, kothVote: { enabled, channel: ch }, roster: {} as never, siteBaseUrl: "https://x" }) as unknown as Ctx;
  const input = (actor = "d0") => ({ actorDiscordId: actor, isAdmin: false, string: () => null, integer: () => null, boolean: () => null, user: () => null }) as unknown as CommandInput;

  it("opens a vote: frozen electorate, the starter's Yes, the message posted", async () => {
    await populate(6, 5);
    const ch = channel();
    const reply = await start(ctx(ch), input());
    expect(reply.ephemeral).toBe(true);
    const [v] = await db.select().from(kothVotes);
    expect(v).toMatchObject({ slotAt: SLOT, state: "open", electorateSize: 6, turnoutFloor: 5, channelId: "c1", messageId: "m1", startedByDiscordId: "d0" });
    expect(v!.closesAt).toEqual(at("2026-10-03T15:30:00Z"));
    const voters = await db.select().from(kothVoteVoters);
    expect(voters).toHaveLength(6);
    expect(voters.find((r) => r.discordId === "d0")!.ballot).toBe(true);
    expect(ch.post).toHaveBeenCalledWith(expect.stringContaining("Yes 1 · No 0"), v!.id);
    expect(v!.tallyText).toContain("Yes 1 · No 0");
  });

  it("refuses when voting is off", async () => {
    await populate(6, 5);
    expect((await start(ctx(channel(), false), input())).content).toMatch(/switched off/i);
  });
  it("refuses a caller who is not linked", async () => {
    await populate(6, 5);
    expect((await start(ctx(), input("stranger"))).content).toMatch(/in game/i);
  });
  it("refuses a linked caller who is not in game", async () => {
    await populate(6, 5);
    await db.insert(identityLinks).values({ discordId: "dx", dayzId: "offline", gamertag: "Off", verifiedAt: NOW });
    expect((await start(ctx(), input("dx"))).content).toMatch(/in game/i);
  });
  it("refuses under the population minimum", async () => {
    await populate(6, 3);
    expect((await start(ctx(), input())).content).toMatch(/10 players/);
  });
  it("refuses when fewer than five linked players are online", async () => {
    await populate(4, 8);
    expect((await start(ctx(), input())).content).toMatch(/Not enough linked players/);
  });
  it("refuses a second vote while one is open", async () => {
    await populate(6, 5);
    await start(ctx(), input("d0"));
    expect((await start(ctx(), input("d1"))).content).toMatch(/already open/i);
  });
  it("refuses a slot that has already had a vote", async () => {
    await populate(6, 5);
    await start(ctx(), input("d0"));
    await db.execute(sql`update koth_votes set state = 'failed', closed_at = now()`);
    expect((await start(ctx(), input("d1"))).content).toMatch(/already been a vote/i);
  });
  it("refuses a slot an airdrop holds", async () => {
    await populate(6, 5);
    await db.insert(airdropEvents).values({ serverId, slotAt: SLOT, location: "brena", colour: "blue", decidedAt: NOW, popAtDecision: 0, threshold: "0", state: "announced", manual: true, announcedAt: NOW });
    expect((await start(ctx(), input())).content).toMatch(/airdrop/i);
  });
  it("refuses inside the 24 h gap", async () => {
    await populate(6, 5);
    await db.insert(kothEvents).values({ serverId, slotAt: at("2026-10-03T06:00:00Z"), location: "borek", centreX: "1", centreZ: "1", state: "no_winner", origin: "admin", scheduledByDiscordId: "9" });
    expect((await start(ctx(), input())).content).toMatch(/24 hours/);
  });
  // F6: `kothOpen` (koth-vote-store.ts) is scoped to the SERVER, not the slot — a
  // scheduled admin KotH anywhere blocks a vote, whichever slot it targets.
  it("refuses while a scheduled KotH exists, at a different future slot", async () => {
    await populate(6, 5);
    await db.insert(kothEvents).values({ serverId, slotAt: at("2026-10-04T20:00:00Z"), location: "borek", centreX: "1", centreZ: "1", state: "scheduled", origin: "admin", scheduledByDiscordId: "9" });
    expect((await start(ctx(), input())).content).toMatch(/already scheduled or live/i);
  });
  it("refuses while a scheduled KotH exists AT the vote's own target slot", async () => {
    await populate(6, 5);
    await db.insert(kothEvents).values({ serverId, slotAt: SLOT, location: "borek", centreX: "1", centreZ: "1", state: "scheduled", origin: "admin", scheduledByDiscordId: "9" });
    expect((await start(ctx(), input())).content).toMatch(/already scheduled or live/i);
  });
  it("voids the vote and says so when the message cannot be posted", async () => {
    await populate(6, 5);
    const ch = { post: vi.fn(async () => { throw new Error("gone"); }), edit: vi.fn() } as never;
    expect((await start(ctx(ch), input())).content).toMatch(/could not post/i);
    const [v] = await db.select().from(kothVotes);
    expect(v!.state).toBe("void");
    expect(v!.resultPostedAt).not.toBeNull();
  });
  // Review focus 5.
  it("maps a unique violation to the matching refusal", async () => {
    const { voteConstraintReply } = await import("../src/commands/kothvote.js");
    expect(voteConstraintReply("koth_votes_one_open")).toMatch(/already open/i);
    expect(voteConstraintReply("koth_votes_slot_uq")).toMatch(/already been a vote/i);
    expect(voteConstraintReply("something_else")).toBeNull();
  });
  it("registers /kothvote with no options and no default permissions", () => {
    const json = kothVoteGroup.command.toJSON();
    expect(json.name).toBe("kothvote");
    expect(json.options ?? []).toHaveLength(0);
    expect(json.default_member_permissions ?? null).toBeNull();
  });
  it("round-trips the vote button id", () => {
    expect(parseVoteButtonId(voteButtonId(42, true))).toEqual({ voteId: 42, yes: true });
    expect(parseVoteButtonId(voteButtonId(42, false))).toEqual({ voteId: 42, yes: false });
    expect(parseVoteButtonId("cw:c:x:1:")).toBeNull();
  });
});
