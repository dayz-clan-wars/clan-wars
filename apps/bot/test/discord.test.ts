import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, players, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PermissionFlagsBits } from "discord.js";
import { PgVerificationStore } from "../src/store.js";
import {
  buildCommands, routeInteraction, notifyCompleted, guardedRunner, LINK_NEW_SEQUENCE_OPTION,
  playerSuggestions, createNicknameApplier, type NicknameClientLike, type RealGuildLike,
} from "../src/discord.js";
import type { CommandDeps } from "../src/commands.js";
import type { NicknameOutcome } from "../src/nickname.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
/** The character /link names. Seeded into `players`; the command refuses a UID the log has never seen. */
const TARGET = UID_A;

describe("discord wiring", () => {
  let db: Database;
  let store: PgVerificationStore;
  let deps: CommandDeps;
  const now = new Date("2026-08-26T12:00:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // faction_members is truncated too even though this suite never writes it:
    // handleUnlink refuses a roster member, and files here share one database
    // (fileParallelism is off, but leftovers survive between files), so a
    // membership left by another suite silently changes /unlink's answer.
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links, players, faction_members, factions, servers restart identity cascade`);
    });
    store = new PgVerificationStore(db);
    deps = { store, rng: Math.random, now: () => now, challengeTtlMs: 600_000 };
    // Fixture clock, not new Date(): the whole suite reasons about `now`.
    await db.insert(players).values({ dayzId: TARGET, gamertag: "Ronald", firstSeenAt: now, lastSeenAt: now });
  });

  it("dormancy modules load and their signatures match how startBot calls them", async () => {
    // ⚠️ This does NOT prove the tick is wired into the bot's guarded job.
    // Deleting the dormancy block from `startBot`'s runner would leave this
    // test green, because it only imports the modules and calls them exactly
    // as it would if `discord.ts` never touched them at all. What it does
    // prove: the modules load without throwing, and `dormancyTick`'s and
    // `notifyDormancy`'s signatures still match the shape `startBot` calls
    // them with, so a rename or a reordered argument fails here instead of
    // silently at runtime. Actual wiring — that `startBot` really runs this
    // every tick — can only be confirmed by a live deployment check.
    const { dormancyTick } = await import("../src/dormancy-tick.js");
    const { PgDormancyStore } = await import("../src/dormancy-store.js");
    const { notifyDormancy } = await import("../src/dormancy-notify.js");
    expect(typeof dormancyTick).toBe("function");
    expect(typeof notifyDormancy).toBe("function");

    const store = new PgDormancyStore(db);
    const r = await dormancyTick(store, {
      now: new Date("2026-09-02T12:00:00Z"),
      windows: { dormantAfterMs: 604_800_000, disbandAfterDormantMs: 1_209_600_000 },
    });
    expect(r.examined).toBe(0);

    // Actually invoke notifyDormancy too, not just typeof-check it: an empty
    // notices array plus a stub sender still exercises its parameter shape,
    // so a reordered (notices, send) signature fails here rather than only
    // at runtime.
    const sent = await notifyDormancy([], async () => {});
    expect(sent).toBe(0);
  });

  describe("buildCommands", () => {
    it("declares link, unlink, whoami and faction", () => {
      expect(buildCommands().map((c) => c.name).sort()).toEqual(["faction", "link", "unlink", "whoami"]);
    });

    it("registers every roster subcommand", () => {
      const faction = buildCommands().find((c) => c.name === "faction")!;
      const names = (faction.options ?? []).map((o: any) => o.name).sort();
      expect(names).toEqual([
        "claim", "demote", "disband", "info", "invite", "invites",
        "kick", "leave", "promote", "rebind", "rename", "roster", "transfer",
      ]);
    });

    it("registers /link with a required autocompleting gamertag option", () => {
      const link = buildCommands().find((c) => c.name === "link")!;
      const opt = (link.options ?? [])[0] as any;
      expect(opt.name).toBe("gamertag");
      expect(opt.required).toBe(true);
      expect(opt.autocomplete).toBe(true);
    });

    it("truncates a choice name to Discord's 100-character limit", () => {
      // ⚠️ Discord rejects a choice whose name exceeds 100 characters, and a
      // rejected autocomplete response renders as an EMPTY field rather than
      // an error — the player simply cannot pick anyone. Nothing constrains
      // `players.gamertag` to a sane length, so clamp here.
      const long = "x".repeat(140);
      const [choice] = playerSuggestions([{ dayzId: "1", gamertag: long }], "x");
      expect(choice!.name.length).toBe(100);
      // The UID is what the submit path uses, so it must survive intact.
      expect(choice!.value).toBe("1");
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

  describe("playerSuggestions", () => {
    it("returns at most Discord's 25 choices", () => {
      // ⚠️ Discord rejects an autocomplete response with more than 25 choices,
      // and the field then shows nothing at all. The candidate POOL is 50.
      const many = Array.from({ length: 50 }, (_, i) => ({ dayzId: `${i}`, gamertag: `P${i}` }));
      expect(playerSuggestions(many, "")).toHaveLength(25);
    });

    it("filters case-insensitively on the typed query", () => {
      const ps = [{ dayzId: "1", gamertag: "RonaldRaygun552" }, { dayzId: "2", gamertag: "Someone" }];
      expect(playerSuggestions(ps, "ronald")).toEqual([{ name: "RonaldRaygun552", value: "1" }]);
    });

    it("carries the UID as the value, not the gamertag", () => {
      // Two characters can share a display name; the UID disambiguates and
      // means the submit path never re-resolves a name.
      const ps = [{ dayzId: "abc", gamertag: "Twin" }, { dayzId: "def", gamertag: "Twin" }];
      expect(playerSuggestions(ps, "twin").map((c) => c.value)).toEqual(["abc", "def"]);
    });
  });

  describe("routeInteraction", () => {
    const base = { userId: "100", guildId: "g", channelId: "c" };

    it("routes /link", async () => {
      const r = await routeInteraction(deps, { ...base, commandName: "link", targetDayzId: TARGET });
      expect(r?.ephemeral).toBe(true);
      expect(await store.findLiveChallenge("100", now)).toMatchObject({ targetDayzId: TARGET });
    });

    it("refuses /link with no character chosen", async () => {
      // Registration makes the option required, so this only happens to a
      // stale command — and an untargeted challenge is the bug this removes.
      const r = await routeInteraction(deps, { ...base, commandName: "link" });
      expect(r?.content).toMatch(/pick a character/i);
      expect(await store.findLiveChallenge("100", now)).toBeNull();
    });

    it("passes /link's new-sequence option through to the handler", async () => {
      // ⚠️ The option has to exist at registration AND be read here. Wired at
      // only one end, the re-roll is unreachable in Discord while every
      // handler test still passes.
      const registered = buildCommands().find((c) => c.name === "link") as { options?: { name: string }[] };
      expect(registered.options?.map((o) => o.name)).toContain(LINK_NEW_SEQUENCE_OPTION);

      await routeInteraction(deps, { ...base, commandName: "link", targetDayzId: UID_A });
      const first = (await store.findLiveChallenge("100", now))!.sequence;
      await routeInteraction(deps, { ...base, commandName: "link", targetDayzId: UID_A, newSequence: true });
      expect((await store.findLiveChallenge("100", now))!.sequence).not.toEqual(first);
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
        targetDayzId: uid,
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

    it("attempts the rename with the guild, discord id, and gamertag of the newly-bound link", async () => {
      await complete("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      const renameOnLink = vi.fn().mockResolvedValue("ok" as NicknameOutcome);
      await notifyCompleted(deps, send, undefined, renameOnLink);
      expect(renameOnLink).toHaveBeenCalledWith("g", "100", "Steve");
    });

    it("reports a successful rename in the DM content", async () => {
      await complete("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      const renameOnLink = vi.fn().mockResolvedValue("ok" as NicknameOutcome);
      await notifyCompleted(deps, send, undefined, renameOnLink);
      expect(send.mock.calls[0]?.[0]?.content).toMatch(/nickname has been set/i);
    });

    it("reports why the rename failed without failing the notification", async () => {
      await complete("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      const renameOnLink = vi.fn().mockResolvedValue("outranked" as NicknameOutcome);
      expect(await notifyCompleted(deps, send, undefined, renameOnLink)).toBe(1);
      const content = send.mock.calls[0]?.[0]?.content as string;
      expect(content).toMatch(/verified/i);
      expect(content).toMatch(/role is below yours/i);
    });

    it("still sends the DM and marks the challenge notified when the renamer throws", async () => {
      // Regression guard: `renameOnLink` calls into a real discord.js
      // permission predicate and guild fetch, neither of which is guaranteed
      // not to throw (e.g. a not-yet-cached Guild). That throw must be caught
      // in its OWN try/catch, separate from the one guarding `send` and
      // `markNotified` below — if it escaped into that outer catch, this
      // would behave exactly like a failed `send`: no DM, challenge stays
      // pending, retried forever. It must not: the rename is best-effort,
      // the notification is not.
      await complete("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      const renameOnLink = vi.fn().mockRejectedValue(new Error("permission predicate exploded"));
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await notifyCompleted(deps, send, undefined, renameOnLink)).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]?.content).toMatch(/could not be changed right now/i);
      expect(await store.pendingNotifications()).toHaveLength(0);
      expect(warned).toHaveBeenCalled();
      warned.mockRestore();
    });

    const exhaust = async (discordId: string, uid: string, opts: { sequence?: string[]; progressIndex?: number } = {}) => {
      const c = await store.createChallenge({
        discordId, guildId: "g", channelId: "c",
        sequence: opts.sequence ?? ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000),
        targetDayzId: uid,
      });
      expect(c).not.toBeNull();
      if (opts.progressIndex !== undefined) {
        await store.upsertAttempt(c!.id, uid, opts.progressIndex, 1, 8);
      }
      expect(await store.cancelChallenge(c!.id, now, "budget-exhausted")).toBe(true);
      return c!;
    };

    it("names the emote a locked-out player never reached", async () => {
      // ⚠️ The diagnostic half. Wintershadow394 (2026-09-01) performed the
      // second and third emotes of his sequence eight times and never the
      // first — he could not find "move" on the wheel. The old message told
      // him only that too many emotes were performed, which reads as an
      // accusation of fumbling and hides the emote that actually blocked him.
      await exhaust("100", UID_A, { sequence: ["EmoteMove", "EmoteClap", "EmoteDance"], progressIndex: 0 });
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await notifyCompleted(deps, send)).toBe(1);
      const content = send.mock.calls[0]?.[0]?.content as string;
      expect(content).toMatch(/\bmove\b/);
      expect(content).toMatch(/first/i);
    });

    it("names the emote a partway player never reached", async () => {
      await exhaust("100", UID_A, { sequence: ["EmoteMove", "EmoteClap", "EmoteDance"], progressIndex: 2 });
      const send = vi.fn().mockResolvedValue(undefined);
      await notifyCompleted(deps, send);
      const content = send.mock.calls[0]?.[0]?.content as string;
      expect(content).toMatch(/\bdance\b/);
      expect(content).not.toMatch(/first/i);
    });

    it("⚠️ never states the emote budget as a number", async () => {
      // discord.ts documents why: the budget is the primary defence against a
      // target backing into its own sequence, and a player who reads it as a
      // target to optimise against has misunderstood the task. Naming the
      // missing EMOTE is what is actionable; naming the count is not.
      await exhaust("100", UID_A, { sequence: ["EmoteMove", "EmoteClap", "EmoteDance"], progressIndex: 0 });
      const send = vi.fn().mockResolvedValue(undefined);
      await notifyCompleted(deps, send);
      const content = send.mock.calls[0]?.[0]?.content as string;
      expect(content).not.toMatch(/\b8\b|\beight\b/i);
    });

    it("tells a player whose budget ran out to run /link again, exactly once", async () => {
      // Spec §5.3. The tick cancels the challenge; without this the player
      // gets silence, then three different emotes on their next /link with no
      // explanation of why the first set stopped working.
      await exhaust("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await notifyCompleted(deps, send)).toBe(1);
      const content = send.mock.calls[0]?.[0]?.content as string;
      expect(content).toMatch(/canceled/i);
      expect(content).toMatch(/\/link/);
      expect(content).not.toMatch(/verified/i);
      expect(await notifyCompleted(deps, send)).toBe(0);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("attempts no rename for a cancellation, because nothing was bound", async () => {
      // A renamer here would be renaming on the strength of a link that does
      // not exist — and a "your nickname could not be changed" suffix would
      // tell a player something failed that was never even relevant.
      await exhaust("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      const renameOnLink = vi.fn().mockResolvedValue("ok" as NicknameOutcome);
      expect(await notifyCompleted(deps, send, undefined, renameOnLink)).toBe(1);
      expect(renameOnLink).not.toHaveBeenCalled();
      expect(send.mock.calls[0]?.[0]?.content).not.toMatch(/nickname/i);
    });

    it("leaves a cancellation pending when its send throws", async () => {
      await exhaust("100", UID_A);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await notifyCompleted(deps, vi.fn().mockRejectedValue(new Error("DMs closed")))).toBe(0);
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
      expect(await notifyCompleted(deps, vi.fn().mockResolvedValue(undefined))).toBe(1);
    });

    it("attempts no rename, and says nothing about a nickname, when no renamer is supplied", async () => {
      // No default stand-in function: an unsupplied renamer means "not
      // attempted", which is a different message than "attempted and
      // failed" — a player told a rename failed when none was tried would
      // be misled about what to do next.
      await complete("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await notifyCompleted(deps, send)).toBe(1);
      expect(send.mock.calls[0]?.[0]?.content).not.toMatch(/nickname/i);
      expect(await store.pendingNotifications()).toHaveLength(0);
    });
  });

  describe("notify failure logging", () => {
    const complete = async (discordId: string, uid: string) => {
      const c = await store.createChallenge({
        discordId, guildId: "g", channelId: "c",
        sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000),
        targetDayzId: uid,
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

  describe("createNicknameApplier", () => {
    function fakeClient(guild: RealGuildLike | Error): NicknameClientLike {
      return {
        guilds: {
          fetch: async () => {
            if (guild instanceof Error) throw guild;
            return guild;
          },
        },
      };
    }

    it("renames through the adapted guild when permitted", async () => {
      const setNickname = vi.fn().mockResolvedValue(undefined);
      const has = vi.fn(() => true);
      const client = fakeClient({
        ownerId: "owner",
        members: {
          fetch: async () => ({ manageable: true, setNickname }),
          me: { permissions: { has } },
        },
      });
      const outcome = await createNicknameApplier(client)("g", "u1", "Ronald");
      expect(outcome).toBe("ok");
      expect(setNickname).toHaveBeenCalledWith("Ronald");
      // Guards against plumbing the wrong permission flag through the
      // adapter — a fake that ignores its argument would pass this test
      // regardless of which flag (or none) was actually checked.
      expect(has).toHaveBeenCalledWith(PermissionFlagsBits.ManageNicknames);
    });

    it("reports no-permission via the real guild's members.me permission check", async () => {
      const has = vi.fn(() => false);
      const client = fakeClient({
        ownerId: "owner",
        members: {
          fetch: async () => ({ manageable: true, setNickname: vi.fn() }),
          me: { permissions: { has } },
        },
      });
      expect(await createNicknameApplier(client)("g", "u1", "Ronald")).toBe("no-permission");
      expect(has).toHaveBeenCalledWith(PermissionFlagsBits.ManageNicknames);
    });

    it("treats an absent members.me the same as lacking the permission", async () => {
      // A real discord.js `members.me` can be null before the client has
      // cached its own member for the guild; that must read as "cannot
      // rename yet", not throw.
      const client = fakeClient({
        ownerId: "owner",
        members: { fetch: async () => ({ manageable: true, setNickname: vi.fn() }), me: null },
      });
      expect(await createNicknameApplier(client)("g", "u1", "Ronald")).toBe("no-permission");
    });

    it("reports failed, without throwing, when the guild itself cannot be fetched", async () => {
      const client = fakeClient(new Error("unknown guild"));
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await createNicknameApplier(client)("g", "u1", "Ronald")).toBe("failed");
      warned.mockRestore();
    });
  });
});
