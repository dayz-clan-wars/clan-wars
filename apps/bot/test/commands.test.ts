import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
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
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links restart identity cascade`);
    store = new PgVerificationStore(db);
    deps = { store, rng: Math.random, now: () => now, challengeTtlMs: 600_000 };
  });

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

    it("refuses when the account is already linked", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000) });
      await store.completeChallenge(c.id, UID_A, "Steve", now);
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
  });

  describe("handleUnlink", () => {
    it("reports when there was nothing to unlink", async () => {
      expect((await handleUnlink(deps, "100")).content).toMatch(/not linked/i);
    });

    it("removes an existing link", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000) });
      await store.completeChallenge(c.id, UID_A, "Steve", now);
      expect((await handleUnlink(deps, "100")).content).toMatch(/unlinked/i);
      expect(await store.findLinkByDiscord("100")).toBeNull();
    });
  });

  describe("handleWhoami", () => {
    it("reports an unlinked account", async () => {
      expect((await handleWhoami(deps, "100")).content).toMatch(/not linked/i);
    });

    it("reports the linked gamertag", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000) });
      await store.completeChallenge(c.id, UID_A, "Steve", now);
      expect((await handleWhoami(deps, "100")).content).toContain("Steve");
    });

    it("does not print the full UID", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000) });
      await store.completeChallenge(c.id, UID_A, "Steve", now);
      expect((await handleWhoami(deps, "100")).content).not.toContain(UID_A);
    });
  });
});
