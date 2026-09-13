import { describe, it, expect } from "vitest";
import { discordCopy, DISBAND_WARNING, REFUSAL } from "@factions/copy";
import { clanGroup } from "../src/commands/clan.js";
import { clanEmbed } from "../src/commands/embeds/clan.js";
import { specOf, sourceOf, componentOf, input, ctxWith, viewFixture } from "./command-fakes.js";

const spec = (path: string) => specOf(clanGroup, path);

describe("/clan info", () => {
  it("tells an unlinked player to link, without touching the clan read's shape", async () => {
    const ctx = ctxWith({ clanFor: async () => "not-linked" });
    expect((await spec("clan info").handler(ctx, input())).content).toBe(REFUSAL["not-linked"]);
  });

  it("tells a clanless player where to look", async () => {
    const ctx = ctxWith({ clanFor: async () => "not-in-clan" });
    expect((await spec("clan info").handler(ctx, input())).content).toContain("/clans list");
  });
});

describe("clanEmbed", () => {
  /** ⚠️ A rebind candidate names the raiser and the time. Never the pole. */
  it("never renders a pole key or a coordinate for a rebind candidate", () => {
    const view = viewFixture({ rebindCandidates: [{ poleKey: "3021_9944", raisedAt: new Date("2026-09-12T00:00:00Z"), by: "Vasily" }] });
    const json = JSON.stringify(clanEmbed(view, "https://x"));
    expect(json).toContain("Vasily");
    expect(json).not.toContain("3021_9944");
  });

  it("renders the clan's own base, which is the one coordinate a member may see", () => {
    const view = viewFixture({ clan: { ...viewFixture().clan, base: { x: 3021.4, z: 9944.6 } } });
    expect(JSON.stringify(clanEmbed(view, "https://x"))).toContain("3021");
  });
});

describe("/clan disband", () => {
  it("asks for a confirm and shows the warning, without writing", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ disband: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("clan disband").handler(ctx, input());
    expect(seen).toEqual([]);
    expect(reply.content).toContain(DISBAND_WARNING);
    expect(reply.content).toContain(discordCopy("disband", "unconfirmed"));
    expect(reply.components).toHaveLength(1);
  });

  it("writes on the press", async () => {
    const ctx = ctxWith({ disband: async () => "ok" });
    expect((await componentOf(clanGroup, "disband")(ctx, { actorDiscordId: "111", arg: null, values: [] })).content)
      .toBe(discordCopy("disband", "ok"));
  });

  it("renders every disband outcome on the button press", async () => {
    for (const o of ["ok", "not-leader", "vote-open", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ disband: async () => o });
      const reply = await componentOf(clanGroup, "disband")(ctx, { actorDiscordId: "111", arg: null, values: [] });
      expect(reply.content, o).toBe(discordCopy("disband", o));
    }
  });
});

describe("/clan leave", () => {
  /** R3: the site does not gate Leave behind a checkbox, so neither does Discord. No confirm here. */
  it("writes immediately, with no confirm button", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ leave: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("clan leave").handler(ctx, input());
    expect(seen).toEqual(["ran"]);
    expect(reply.components).toBeUndefined();
    expect(reply.content).toBe(discordCopy("leave", "ok"));
  });

  it("renders every leave outcome from the shared table", async () => {
    for (const o of ["ok", "not-member", "leader-must-transfer", "not-in-clan"] as const) {
      const ctx = ctxWith({ leave: async () => o });
      expect((await spec("clan leave").handler(ctx, input())).content, o).toBe(discordCopy("leave", o));
    }
  });
});

describe("/clan rename", () => {
  it("passes the tag through only when one was given", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ rename: async (_a: string, r: unknown) => { seen.push(r); return "ok"; } });
    await spec("clan rename").handler(ctx, input({ name: "Wolves" }));
    await spec("clan rename").handler(ctx, input({ name: "Wolves", tag: "WLF" }));
    expect(seen).toEqual([{ name: "Wolves" }, { name: "Wolves", tag: "WLF" }]);
  });

  it("refuses without a name, without calling the roster", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ rename: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("clan rename").handler(ctx, input({}));
    expect(seen).toEqual([]);
    expect(reply.content).toContain("Give");
  });

  it("renders every RenameOutcome from the shared table", async () => {
    for (const o of ["ok", "not-leader", "cooldown", "name-taken", "tag-taken", "name-held", "tag-held",
                     "unchanged", "bad-name", "bad-tag", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ rename: async () => o });
      expect((await spec("clan rename").handler(ctx, input({ name: "Wolves" }))).content, o).toBe(discordCopy("rename", o));
    }
  });
});

describe("/clan recruiting", () => {
  it("sends the three optional fields as null when they are left off", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ setRecruitingPost: async (_a: string, p: unknown) => { seen.push(p); return "ok"; } });
    await spec("clan recruiting").handler(ctx, input({ open: true }));
    expect(seen).toEqual([{ recruiting: true, playWindow: null, language: null, pitch: null }]);
  });

  it("sends the optional fields when given", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ setRecruitingPost: async (_a: string, p: unknown) => { seen.push(p); return "ok"; } });
    await spec("clan recruiting").handler(ctx, input({ open: false, hours: "18:00-22:00 UTC", language: "EN", pitch: "Chill raiders" }));
    expect(seen).toEqual([{ recruiting: false, playWindow: "18:00-22:00 UTC", language: "EN", pitch: "Chill raiders" }]);
  });

  it("renders every outcome, including the shared actor refusals", async () => {
    for (const o of ["ok", "not-permitted", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ setRecruitingPost: async () => o });
      expect((await spec("clan recruiting").handler(ctx, input({ open: true }))).content, o).toBe(discordCopy("recruiting", o));
    }
  });
});

describe("/clan rebind", () => {
  it("refuses without a chosen pole, without calling the roster", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ confirmRebind: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("clan rebind").handler(ctx, input({}));
    expect(seen).toEqual([]);
    expect(reply.content).toContain("Pick");
  });

  it("passes the pole key through", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ confirmRebind: async (a: string, p: string) => { seen.push([a, p]); return "ok"; } });
    await spec("clan rebind").handler(ctx, input({ pole: "3021_9944" }));
    expect(seen).toEqual([["111", "3021_9944"]]);
  });

  it("renders every outcome from the shared table", async () => {
    for (const o of ["ok", "refused", "too-close", "no-candidate", "not-leader", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ confirmRebind: async () => o });
      expect((await spec("clan rebind").handler(ctx, input({ pole: "3021_9944" }))).content, o).toBe(discordCopy("rebind", o));
    }
  });
});

describe("/clan rebind autocomplete", () => {
  it("labels a candidate by who raised it and when, and values it by the pole key", async () => {
    const ctx = ctxWith({ clanFor: async () => viewFixture({
      rebindCandidates: [{ poleKey: "3021_9944", raisedAt: new Date("2026-09-12T00:00:00Z"), by: "Vasily" }],
    }) });
    const [choice] = await sourceOf(clanGroup, "clan rebind", "pole")(ctx, { actorDiscordId: "111", value: "" });
    expect(choice!.value).toBe("3021_9944");
    expect(choice!.name).toContain("Vasily");
  });

  it("offers nothing when the actor has no clan", async () => {
    const ctx = ctxWith({ clanFor: async () => "not-in-clan" });
    expect(await sourceOf(clanGroup, "clan rebind", "pole")(ctx, { actorDiscordId: "111", value: "" })).toEqual([]);
  });
});

describe("clan reply ephemerality", () => {
  it("every clan reply is ephemeral, including the disband confirm and its button press", async () => {
    const view = viewFixture();
    const ctx = ctxWith({
      clanFor: async () => view, leave: async () => "ok", rename: async () => "ok",
      setRecruitingPost: async () => "ok", confirmRebind: async () => "ok", disband: async () => "ok",
    });
    for (const path of ["clan info", "clan leave", "clan rename", "clan recruiting", "clan rebind"]) {
      const opts = path === "clan rename" ? { name: "Wolves" }
        : path === "clan recruiting" ? { open: true }
        : path === "clan rebind" ? { pole: "3021_9944" }
        : {};
      const reply = await spec(path).handler(ctx, input(opts));
      expect(reply.ephemeral, path).toBe(true);
    }
    const disbandPrompt = await spec("clan disband").handler(ctx, input());
    expect(disbandPrompt.ephemeral).toBe(true);
    const pressed = await componentOf(clanGroup, "disband")(ctx, { actorDiscordId: "111", arg: null, values: [] });
    expect(pressed.ephemeral).toBe(true);
  });
});
