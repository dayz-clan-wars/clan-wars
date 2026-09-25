import { describe, it, expect } from "vitest";
import { discordCopy } from "@factions/copy";
import { guestGroup } from "../src/commands/guest.js";
import { ctxWith, input, sourceOf, specOf, viewFixture } from "./command-fakes.js";

const spec = (path: string) => specOf(guestGroup, path);

describe("/guest grant", () => {
  it("prefers the user option and falls back to the gamertag", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ grantGuestPass: async (_a: string, t: unknown) => { seen.push(t); return { outcome: "ok", passId: 1 }; } });
    await spec("guest grant").handler(ctx, input({ user: "222" }));
    await spec("guest grant").handler(ctx, input({ gamertag: "Survivor" }));
    expect(seen).toEqual([{ discordId: "222" }, { gamertag: "Survivor" }]);
  });

  it("asks for one of the two when given neither", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ grantGuestPass: async () => { seen.push("ran"); return { outcome: "ok", passId: 1 }; } });
    expect((await spec("guest grant").handler(ctx, input())).content).toContain("Pick");
    expect(seen).toEqual([]);
  });

  it("renders every GuestGrantOutcome from the shared table", async () => {
    for (const o of ["ok", "not-permitted", "already-active", "is-member", "self",
                     "target-not-linked", "ambiguous-gamertag", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ grantGuestPass: async () => ({ outcome: o, passId: null }) });
      expect((await spec("guest grant").handler(ctx, input({ user: "222" }))).content, o).toBe(discordCopy("guest", o));
    }
  });
});

describe("/guest revoke", () => {
  it("offers the clan's open passes and revokes the chosen one", async () => {
    const ctx = ctxWith({
      clanFor: async () => viewFixture({ guestPasses: [{ id: 3, userDiscordId: "222", userGamertag: null, grantedBy: "111", expiresAt: new Date() }] }),
      revokeGuestPass: async (_a: string, id: number) => (id === 3 ? "ok" : "gone"),
    });
    const [choice] = await sourceOf(guestGroup, "guest revoke", "pass")(ctx, { actorDiscordId: "111", value: "" });
    expect(choice!.value).toBe("3");
    expect((await spec("guest revoke").handler(ctx, input({ pass: "3" }))).content).toBe(discordCopy("revoke-guest", "ok"));
  });

  /** M5: the autocomplete label names the guest instead of showing a raw Discord id. */
  it("labels a linked guest's choice by gamertag", async () => {
    const ctx = ctxWith({
      clanFor: async () => viewFixture({ guestPasses: [{ id: 3, userDiscordId: "222", userGamertag: "Gus", grantedBy: "111", expiresAt: new Date() }] }),
    });
    const [choice] = await sourceOf(guestGroup, "guest revoke", "pass")(ctx, { actorDiscordId: "111", value: "" });
    expect(choice!.name).toBe("Gus");
    expect(choice!.value).toBe("3");
  });

  /** M5: an unlinked guest still reads as a person, and the id keeps two of them apart. */
  it("falls back to 'Discord user <id>' for an unlinked guest's choice", async () => {
    const ctx = ctxWith({
      clanFor: async () => viewFixture({ guestPasses: [{ id: 3, userDiscordId: "222", userGamertag: null, grantedBy: "111", expiresAt: new Date() }] }),
    });
    const [choice] = await sourceOf(guestGroup, "guest revoke", "pass")(ctx, { actorDiscordId: "111", value: "" });
    expect(choice!.name).toBe("Discord user 222");
    expect(choice!.value).toBe("3");
  });
});
