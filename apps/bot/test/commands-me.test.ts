import { describe, it, expect } from "vitest";
import { discordCopy } from "@factions/copy";
import type { Attention, Viewer } from "@factions/roster";
import { meGroup } from "../src/commands/me.js";
import { meEmbed } from "../src/commands/embeds/me.js";
import { specOf, sourceOf, input, ctxWith } from "./command-fakes.js";

const spec = (path: string) => specOf(meGroup, path);

const NO_ATTENTION: Attention = { you: 0, clan: 0 };

describe("/me accept", () => {
  it("passes the chosen invite id through as a number and renders the table's copy", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ acceptInvite: async (d: string, id: number) => { seen.push([d, id]); return "ok"; } });
    const reply = await spec("me accept").handler(ctx, input({ invite: "42" }));
    expect(seen).toEqual([["111", 42]]);
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toBe(discordCopy("accept", "ok"));
  });

  it("refuses a non-numeric invite id without calling the roster", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ acceptInvite: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("me accept").handler(ctx, input({ invite: "not-a-number" }));
    expect(seen).toEqual([]);
    expect(reply.content).toContain("Pick");
  });

  it("renders every outcome the roster can return", async () => {
    for (const outcome of ["ok", "gone", "already-member", "cooldown", "not-holding", "link-changed", "cap", "not-linked"] as const) {
      const ctx = ctxWith({ acceptInvite: async () => outcome });
      const reply = await spec("me accept").handler(ctx, input({ invite: "1" }));
      expect(reply.content, outcome).toBe(discordCopy("accept", outcome));
    }
  });
});

describe("/me decline and /me withdraw", () => {
  it("maps the boolean the store returns onto the table's two keys", async () => {
    for (const [ok, key] of [[true, "declined"], [false, "gone"]] as const) {
      const ctx = ctxWith({ declineInvite: async () => ok });
      expect((await spec("me decline").handler(ctx, input({ invite: "1" }))).content).toBe(discordCopy("decline", key));
    }
    for (const [ok, key] of [[true, "withdrawn"], [false, "gone"]] as const) {
      const ctx = ctxWith({ withdrawRequest: async () => ok });
      expect((await spec("me withdraw").handler(ctx, input({ request: "1" }))).content).toBe(discordCopy("withdraw", key));
    }
  });
});

describe("/me autocomplete", () => {
  it("offers only this actor's own open invites", async () => {
    const ctx = ctxWith({
      myInvites: async (d: string) => (d === "111"
        ? [{ id: 7, clanId: 1, clanName: "Wolves", tag: "WLF", serverId: 1, serverName: "s", expiresAt: new Date() }]
        : []),
    });
    const choices = await sourceOf(meGroup, "me accept", "invite")(ctx, { actorDiscordId: "111", value: "" });
    expect(choices).toEqual([{ name: "Wolves [WLF]", value: "7" }]);
  });
});

describe("/me show", () => {
  /** Never imported by any test before this: /me show's happy path had zero coverage. */
  it("renders an embed and passes actorDiscordId to each of the four roster reads", async () => {
    const seen: Record<string, string> = {};
    const viewer: Viewer = { link: { dayzId: "d1", gamertag: "Vasily", verifiedAt: new Date() }, clan: null, pending: null };
    const ctx = ctxWith({
      viewerFor: async (d: string) => { seen.viewerFor = d; return viewer; },
      attention: async (d: string) => { seen.attention = d; return NO_ATTENTION; },
      myInvites: async (d: string) => { seen.myInvites = d; return []; },
      myRequests: async (d: string) => { seen.myRequests = d; return []; },
    });
    const reply = await spec("me show").handler(ctx, input());
    expect(reply.embeds).toHaveLength(1);
    expect(reply.ephemeral).toBe(true);
    expect(seen).toEqual({ viewerFor: "111", attention: "111", myInvites: "111", myRequests: "111" });
  });
});

describe("meEmbed", () => {
  const invites: never[] = [];
  const requests: never[] = [];

  it("returns the no-character-linked card early, before rendering any clan state", () => {
    const v: Viewer = { link: null, clan: null, pending: null };
    const json = JSON.stringify(meEmbed(v, NO_ATTENTION, invites, requests, "https://x"));
    expect(json).toContain("No character linked");
    expect(json).not.toMatch(/Clan/);
  });

  it("shows the clan and role when in a clan", () => {
    const v: Viewer = {
      link: { dayzId: "d1", gamertag: "Vasily", verifiedAt: new Date() },
      clan: { id: 1, name: "Wolves", tag: "WLF", texture: "wolf", status: "active", role: "leader" },
      pending: null,
    };
    const json = JSON.stringify(meEmbed(v, NO_ATTENTION, invites, requests, "https://x"));
    expect(json).toContain("Wolves");
    expect(json).toContain("WLF");
    expect(json).toContain("leader");
  });

  it("shows the pending banner when awaiting presence at a holding clan", () => {
    const v: Viewer = {
      link: { dayzId: "d1", gamertag: "Vasily", verifiedAt: new Date() },
      clan: null,
      pending: { id: 2, name: "Bears", tag: "BER" },
    };
    const json = JSON.stringify(meEmbed(v, NO_ATTENTION, invites, requests, "https://x"));
    expect(json).toContain("Pending");
    expect(json).toContain("Bears");
  });

  it("points a clanless player at /clans list", () => {
    const v: Viewer = { link: { dayzId: "d1", gamertag: "Vasily", verifiedAt: new Date() }, clan: null, pending: null };
    const json = JSON.stringify(meEmbed(v, NO_ATTENTION, invites, requests, "https://x"));
    expect(json).toContain("/clans list");
  });
});
