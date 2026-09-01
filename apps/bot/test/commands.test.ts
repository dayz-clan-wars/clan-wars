import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers,
  type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";
import { handleLink, handleUnlink, handleWhoami, formatSequence, type CommandDeps } from "../src/commands.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const CTX = { discordId: "100", guildId: "g", channelId: "c" };

describe("commands", () => {
  let db: Database;
  let store: PgVerificationStore;
  let deps: CommandDeps;
  const now = new Date("2026-08-26T12:00:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links, faction_members, factions, servers restart identity cascade`);
    store = new PgVerificationStore(db);
    deps = { store, rng: Math.random, now: () => now, challengeTtlMs: 600_000 };
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

    it("shows human-readable emote labels, never raw tokens", async () => {
      const reply = await handleLink(deps, CTX);
      expect(reply.content).not.toMatch(/Emote[A-Z]/);
    });

    it("re-shows the existing challenge instead of issuing a second one", async () => {
      const first = await handleLink(deps, CTX);
      const second = await handleLink(deps, CTX);
      expect(second.content).toBe(first.content);
      expect((await store.liveChallenges(now))).toHaveLength(1);
    });

    it("describes the sequence by its actual length, not a hardcoded word", async () => {
      // generateSequence takes its length as a parameter. A challenge of any
      // other length must not be described to the player as "these three".
      const c = await store.createChallenge({
        ...CTX,
        sequence: ["EmoteSalute", "EmoteClap", "EmoteDance", "EmoteWave"],
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
        targetDayzId: UID_A,
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

    it("does not issue a sequence that is already outstanding", async () => {
      // Pin the rng so the naive implementation would collide.
      const fixed: CommandDeps = { ...deps, rng: () => 0 };
      await handleLink(fixed, CTX);
      await handleLink(fixed, { ...CTX, discordId: "200" });
      const seqs = await store.outstandingSequences(now);
      expect(seqs).toHaveLength(2);
      expect(JSON.stringify(seqs[0])).not.toBe(JSON.stringify(seqs[1]));
    });

    it("redraws when the drawn sequence is already held, and still issues one", async () => {
      // Both calls draw identically from the pinned rng; the DB rejects the
      // second, so handleLink must redraw rather than fail.
      const fixed: CommandDeps = { ...deps, rng: () => 0 };
      const a = await handleLink(fixed, CTX);
      const b = await handleLink(fixed, { ...CTX, discordId: "200" });
      expect(a.content).not.toBe(b.content);

      const seqs = await store.outstandingSequences(now);
      expect(seqs).toHaveLength(2);
      expect(JSON.stringify(seqs[0])).not.toBe(JSON.stringify(seqs[1]));
    });

    it("issues distinct sequences under concurrent /link calls", async () => {
      const fixed: CommandDeps = { ...deps, rng: () => 0 };
      await Promise.all([
        handleLink(fixed, { ...CTX, discordId: "601" }),
        handleLink(fixed, { ...CTX, discordId: "602" }),
        handleLink(fixed, { ...CTX, discordId: "603" }),
      ]);
      const seqs = (await store.outstandingSequences(now)).map((s) => JSON.stringify(s));
      // The database, not a pre-read, is what guarantees this.
      expect(new Set(seqs).size).toBe(seqs.length);
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
