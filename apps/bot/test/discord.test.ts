import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";
import { buildCommands, routeInteraction, notifyCompleted } from "../src/discord.js";
import type { CommandDeps } from "../src/commands.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);

describe("discord wiring", () => {
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

  describe("buildCommands", () => {
    it("declares link, unlink and whoami", () => {
      expect(buildCommands().map((c) => c.name).sort()).toEqual(["link", "unlink", "whoami"]);
    });

    it("gives every command a description", () => {
      // Cast: RESTPostAPIApplicationCommandsJSONBody is a union that also covers
      // context-menu and primary-entry-point commands, neither of which carries
      // a `description`. buildCommands() only ever returns chat-input (slash)
      // commands, which always have one.
      for (const c of buildCommands()) {
        expect((c as { description?: string }).description?.length).toBeGreaterThan(0);
      }
    });
  });

  describe("routeInteraction", () => {
    const base = { userId: "100", guildId: "g", channelId: "c" };

    it("routes /link", async () => {
      const r = await routeInteraction(deps, { ...base, commandName: "link" });
      expect(r?.ephemeral).toBe(true);
      expect(await store.findLiveChallenge("100", now)).not.toBeNull();
    });

    it("routes /whoami", async () => {
      const r = await routeInteraction(deps, { ...base, commandName: "whoami" });
      expect(r?.content).toMatch(/not linked/i);
    });

    it("routes /unlink", async () => {
      const r = await routeInteraction(deps, { ...base, commandName: "unlink" });
      expect(r?.content).toMatch(/not linked/i);
    });

    it("returns null for an unknown command", async () => {
      expect(await routeInteraction(deps, { ...base, commandName: "nope" })).toBeNull();
    });

    it("refuses a command run outside a guild", async () => {
      const r = await routeInteraction(deps, { ...base, guildId: null, commandName: "link" });
      expect(r?.content).toMatch(/server/i);
      expect(await store.findLiveChallenge("100", now)).toBeNull();
    });
  });

  describe("notifyCompleted", () => {
    const complete = async (discordId: string, uid: string) => {
      const c = await store.createChallenge({
        discordId, guildId: "g", channelId: "c",
        sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000),
      });
      expect(c).not.toBeNull();
      await store.completeChallenge(c!.id, uid, "Steve", now);
    };

    it("sends one message per newly completed challenge", async () => {
      await complete("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await notifyCompleted(deps, send)).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toMatchObject({ discordId: "100" });
    });

    it("does not send twice for the same challenge", async () => {
      await complete("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      await notifyCompleted(deps, send);
      expect(await notifyCompleted(deps, send)).toBe(0);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("leaves the challenge unnotified when sending throws", async () => {
      await complete("100", UID_A);
      const send = vi.fn().mockRejectedValue(new Error("DMs closed"));
      expect(await notifyCompleted(deps, send)).toBe(0);
      // Still pending, so a later tick retries rather than losing the message.
      const retry = vi.fn().mockResolvedValue(undefined);
      expect(await notifyCompleted(deps, retry)).toBe(1);
    });
  });
});
