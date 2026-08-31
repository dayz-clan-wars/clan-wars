import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";
import { buildCommands, routeInteraction, notifyCompleted, guardedRunner } from "../src/discord.js";
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
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await notifyCompleted(deps, send)).toBe(0);
      // Reported, not silent — but kept out of the test output so a genuine
      // error in a CI log stands out instead of blending into expected noise.
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
      // Still pending, so a later tick retries rather than losing the message.
      const retry = vi.fn().mockResolvedValue(undefined);
      expect(await notifyCompleted(deps, retry)).toBe(1);
    });
  });

  describe("notify failure logging", () => {
    const complete = async (discordId: string, uid: string) => {
      const c = await store.createChallenge({
        discordId, guildId: "g", channelId: "c",
        sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000),
      });
      expect(c).not.toBeNull();
      await store.completeChallenge(c!.id, uid, "Steve", now);
    };

    it("logs one failing challenge once, however many times it is retried", async () => {
      await complete("100", UID_A);
      const send = vi.fn().mockRejectedValue(new Error("DMs closed"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const seen = new Set<number>();
      await notifyCompleted(deps, send, seen);
      await notifyCompleted(deps, send, seen);
      await notifyCompleted(deps, send, seen);
      expect(send).toHaveBeenCalledTimes(3);
      expect(logged).toHaveBeenCalledTimes(1);
      logged.mockRestore();
    });

    it("keeps one caller's failure log from silencing another's", async () => {
      // Module-level state is shared by every bot instance in the process and
      // by every test file in one module registry. Challenge ids restart at 1
      // after a truncate, so a suppressed log is a cross-suite failure that
      // only appears when the suites run together.
      await complete("100", UID_A);
      const send = vi.fn().mockRejectedValue(new Error("DMs closed"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await notifyCompleted(deps, send, new Set<number>());
      await notifyCompleted(deps, send, new Set<number>());
      expect(logged).toHaveBeenCalledTimes(2);
      logged.mockRestore();
    });
  });

  describe("guardedRunner", () => {
    it("skips a firing while the previous run is still in flight", async () => {
      let resolve!: () => void;
      const job = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
      const runner = guardedRunner(job);

      runner.fire();
      runner.fire();          // must be skipped, not queued
      expect(job).toHaveBeenCalledTimes(1);
      expect(runner.skipped()).toBe(1);

      resolve();
      await runner.inFlight();
      runner.fire();          // previous finished, so this one runs
      expect(job).toHaveBeenCalledTimes(2);
    });

    it("clears the in-flight slot even when the job rejects", async () => {
      const job = vi.fn().mockRejectedValue(new Error("boom"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const runner = guardedRunner(job);
      runner.fire();
      await runner.inFlight();
      // The failure must be reported, not silently absorbed — a guarded job
      // that fails invisibly means verification stops with nothing to show it.
      expect(logged).toHaveBeenCalled();
      // A failed run must not wedge the runner permanently: if the in-flight
      // slot were cleared only on success, verification would stop dead after
      // the first transient database error and never resume.
      runner.fire();
      await runner.inFlight();
      expect(job).toHaveBeenCalledTimes(2);
      logged.mockRestore();
    });

    it("exposes the in-flight promise for shutdown to await", async () => {
      let resolve!: () => void;
      const runner = guardedRunner(() => new Promise<void>((r) => { resolve = r; }));
      expect(runner.inFlight()).toBeNull();
      runner.fire();
      expect(runner.inFlight()).not.toBeNull();
      resolve();
      await runner.inFlight();
    });
  });
});
