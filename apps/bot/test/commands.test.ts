import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, players,
  type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";
import { handleLink, handleUnlink, handleWhoami, formatSequence, type CommandDeps } from "../src/commands.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
/** The character /link is asked to bind, seeded into `players` per test. */
const TARGET = UID_A;
/** A well-formed UID the event log has never seen. */
const UNKNOWN = "F".repeat(40);
const CTX = { discordId: "100", guildId: "g", channelId: "c", targetDayzId: TARGET };

describe("commands", () => {
  let db: Database;
  let store: PgVerificationStore;
  let deps: CommandDeps;
  const now = new Date("2026-08-26T12:00:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links, faction_members, factions, servers, players restart identity cascade`);
    store = new PgVerificationStore(db);
    deps = { store, rng: Math.random, now: () => now, challengeTtlMs: 600_000 };
    // ⚠️ Seeded against the fixture clock, not new Date(): the store orders and
    // filters players by lastSeenAt, and a wall-clock fixture drifts out of the
    // window the rest of the suite reasons about.
    await db.insert(players).values({
      dayzId: TARGET, gamertag: "Ronald", firstSeenAt: now, lastSeenAt: now,
    });
  });

  /** Seeds a holding faction with one member row for `discordId`/`role`. */
  const seedMembership = async (discordId: string, role: "leader" | "officer" | "member", factionName = "Bears") => {
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    const [f] = await db.insert(factions).values({
      serverId: s!.id, name: factionName, tag: factionName.slice(0, 4).toUpperCase(),
      texture: `Flag_${factionName}`, poleKey: "1:2:3", x: "1.00", y: "2.00", z: "3.00",
      status: "active", leaderDiscordId: role === "leader" ? discordId : "someone-else", createdAt: now,
    }).returning();
    await db.insert(factionMembers).values({
      factionId: f!.id, serverId: s!.id, dayzId: "P".repeat(40), discordId, role, joinedAt: now,
    });
  };

  describe("formatSequence", () => {
    it("renders human labels, numbered, not raw tokens", () => {
      const out = formatSequence(["EmoteSalute", "EmoteClap"]);
      expect(out).toContain("salute");
      expect(out).toContain("clap");
      expect(out).not.toContain("EmoteSalute");
      expect(out).toContain("1.");
      expect(out).toContain("2.");
    });
  });

  describe("handleLink", () => {
    it("issues a challenge and replies ephemerally", async () => {
      const reply = await handleLink(deps, CTX);
      expect(reply.ephemeral).toBe(true);
      expect(await store.findLiveChallenge("100", now)).not.toBeNull();
    });

    it("binds the challenge to the character that was named", async () => {
      await handleLink(deps, CTX);
      expect(await store.findLiveChallenge("100", now)).toMatchObject({ targetDayzId: TARGET });
    });

    it("shows human-readable emote labels, never raw tokens", async () => {
      const reply = await handleLink(deps, CTX);
      expect(reply.content).not.toMatch(/Emote[A-Z]/);
    });

    it("refuses a UID the event log has never seen", async () => {
      const r = await handleLink(deps, { ...CTX, targetDayzId: UNKNOWN });
      expect(r.content).toMatch(/have not seen/i);
      expect(await store.liveChallenges(now)).toHaveLength(0);
    });

    it("refuses a character somebody has already linked", async () => {
      // The autocomplete filters these out, but the menu can be stale and a
      // user can type anything into an autocomplete field.
      const c = await store.createChallenge({
        ...CTX, discordId: "999", sequence: ["EmoteSalute"], issuedAt: now,
        expiresAt: new Date(now.getTime() + 1000), targetDayzId: TARGET,
      });
      expect(c).not.toBeNull();
      expect(await store.completeChallenge(c!.id, TARGET, "Ronald", now)).toBe(true);

      const r = await handleLink(deps, CTX);
      expect(r.content).toMatch(/already linked/i);
      expect(await store.findLiveChallenge("100", now)).toBeNull();
    });

    it("names the character in the challenge message", async () => {
      // The player must be able to see they picked the right character before
      // walking in game to perform three emotes.
      const r = await handleLink(deps, CTX);
      expect(r.content).toContain("Ronald");
      expect(r.content).toMatch(/1\./);
      expect(r.content).toMatch(/3\./);
    });

    it("re-shows the existing challenge instead of issuing a second one", async () => {
      const first = await handleLink(deps, CTX);
      const second = await handleLink(deps, CTX);
      expect(second.content).toBe(first.content);
      expect(second.content).toContain("Ronald");
      expect((await store.liveChallenges(now))).toHaveLength(1);
    });

    it("re-shows the character the live challenge names, not the one just typed", async () => {
      // Switching characters mid-challenge is not a thing: the live challenge
      // owns the account's one open slot, and it names its own target.
      const other = "B".repeat(40);
      await db.insert(players).values({ dayzId: other, gamertag: "Nancy", firstSeenAt: now, lastSeenAt: now });
      await handleLink(deps, CTX);
      const r = await handleLink(deps, { ...CTX, targetDayzId: other });
      expect(r.content).toContain("Ronald");
      expect(r.content).not.toContain("Nancy");
    });

    it("describes the sequence by its actual length, not a hardcoded word", async () => {
      // generateSequence takes its length as a parameter. A challenge of any
      // other length must not be described to the player as "these three".
      const c = await store.createChallenge({
        ...CTX,
        sequence: ["EmoteSalute", "EmoteClap", "EmoteDance", "EmoteWave"],
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
        targetDayzId: TARGET,
      });
      expect(c).not.toBeNull();
      const reply = await handleLink(deps, CTX);
      expect(reply.content).not.toMatch(/\bthree\b/i);
      expect(reply.content).toMatch(/\bfour\b/i);
    });

    it("refuses when the account is already linked", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000), targetDayzId: UID_A });
      expect(c).not.toBeNull();
      await store.completeChallenge(c!.id, UID_A, "Steve", now);
      const reply = await handleLink(deps, CTX);
      expect(reply.content).toMatch(/already linked/i);
    });

    it("issues exactly one challenge under concurrent /link calls", async () => {
      // uniqOpenPerAccount, not a pre-read, is what guarantees this: the losing
      // insert returns null and the loser re-reads and shows the winner's.
      const replies = await Promise.all([
        handleLink(deps, CTX), handleLink(deps, CTX), handleLink(deps, CTX),
      ]);
      expect(await store.liveChallenges(now)).toHaveLength(1);
      for (const r of replies) expect(r.content).toContain("Ronald");
    });
  });

  describe("handleUnlink", () => {
    it("reports when there was nothing to unlink", async () => {
      expect((await handleUnlink(deps, "100")).content).toMatch(/not linked/i);
    });

    it("removes an existing link", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000), targetDayzId: UID_A });
      expect(c).not.toBeNull();
      await store.completeChallenge(c!.id, UID_A, "Steve", now);
      expect((await handleUnlink(deps, "100")).content).toMatch(/unlinked/i);
      expect(await store.findLinkByDiscord("100")).toBeNull();
    });

    it("refuses to unlink a faction leader", async () => {
      await seedMembership("d1", "leader", "Bears");
      const c = await store.createChallenge({ ...CTX, discordId: "d1", sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000), targetDayzId: UID_A });
      expect(c).not.toBeNull();
      await store.completeChallenge(c!.id, UID_A, "Steve", now);

      const r = await handleUnlink(deps, "d1");
      expect(r.content).toMatch(/transfer/i);
      expect(r.content).toMatch(/Bears/);
      expect(await store.findLinkByDiscord("d1")).not.toBeNull();
    });

    it("refuses to unlink an ordinary member", async () => {
      await seedMembership("d2", "member", "Wolves");
      const c = await store.createChallenge({ ...CTX, discordId: "d2", sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000), targetDayzId: UID_A });
      expect(c).not.toBeNull();
      await store.completeChallenge(c!.id, UID_A, "Steve", now);

      const r = await handleUnlink(deps, "d2");
      expect(r.content).toMatch(/faction/i);
      expect(r.content).toMatch(/Wolves/);
      expect(await store.findLinkByDiscord("d2")).not.toBeNull();
    });

    it("still unlinks someone on no roster", async () => {
      const c = await store.createChallenge({ ...CTX, discordId: "d3", sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000), targetDayzId: UID_A });
      expect(c).not.toBeNull();
      await store.completeChallenge(c!.id, UID_A, "Steve", now);

      const r = await handleUnlink(deps, "d3");
      expect(r.content).toMatch(/unlinked/i);
      expect(await store.findLinkByDiscord("d3")).toBeNull();
    });
  });

  describe("handleWhoami", () => {
    it("reports an unlinked account", async () => {
      expect((await handleWhoami(deps, "100")).content).toMatch(/not linked/i);
    });

    it("reports the linked gamertag", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000), targetDayzId: UID_A });
      expect(c).not.toBeNull();
      await store.completeChallenge(c!.id, UID_A, "Steve", now);
      expect((await handleWhoami(deps, "100")).content).toContain("Steve");
    });

    it("does not print the full UID", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000), targetDayzId: UID_A });
      expect(c).not.toBeNull();
      await store.completeChallenge(c!.id, UID_A, "Steve", now);
      expect((await handleWhoami(deps, "100")).content).not.toContain(UID_A);
    });
  });
});
