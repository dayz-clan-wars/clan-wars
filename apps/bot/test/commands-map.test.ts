import { describe, it, expect } from "vitest";
import { PIN_RESULT_COPY } from "@factions/copy";
import { mapGroup } from "../src/commands/map.js";
import { ctxWith, input, sourceOf, specOf } from "./command-fakes.js";
import type { MapState } from "@factions/roster";

const pin = (over: Partial<MapState["pins"][number]> = {}): MapState["pins"][number] => ({
  id: 1, x: 4200, z: 8100, icon: "loot", note: "crates", by: "Ada",
  at: new Date("2026-09-12T10:00:00Z"), expiresAt: new Date("2026-09-19T10:00:00Z"), ...over,
});

const mapFixture = (over: Partial<MapState> = {}): MapState => ({
  world: { size: 12800 },
  you: { gamertag: "Ada", fix: null },
  base: null,
  clanmates: [],
  intruders: [{ gamertag: "Rat", x: 1, z: 2, lastSeenAt: new Date(), distanceM: 300 }],
  publicBases: [{ x: 9, z: 9, texture: "wolf" }],
  pins: [pin()],
  travelPoints: [],
  hub: { x: 0, z: 0 },
  layers: { base: true, clanmates: true, intruders: true, pins: true },
  ...over,
});

describe("/map pins", () => {
  it("lists the clan's own pins with their ids", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture() });
    const reply = await specOf(mapGroup, "map pins").handler(ctx, input());
    const j = reply.embeds![0]!.toJSON();
    expect(JSON.stringify(j.fields)).toContain("crates");
    expect(JSON.stringify(j.fields)).toContain("#1");
    expect(reply.ephemeral).toBe(true);
  });

  /**
   * ⚠️ The card renders the VIEWER'S OWN clan's pins and nothing else.
   * `MapState` also carries intruders and public bases — other players'
   * positions and other clans' bases. Those are raid targets and the site
   * draws them under its own gate; no Discord reply may carry them.
   */
  it("never renders an intruder or another clan's base", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture() });
    const reply = await specOf(mapGroup, "map pins").handler(ctx, input());
    const rendered = JSON.stringify(reply.embeds![0]!.toJSON());
    expect(rendered).not.toContain("Rat");
    expect(rendered).not.toContain("wolf");
  });

  it("refuses a player with no link, in the shared words", async () => {
    const ctx = ctxWith({ mapState: async () => "not-linked" });
    const reply = await specOf(mapGroup, "map pins").handler(ctx, input());
    expect(reply.content).toBe(PIN_RESULT_COPY["not-linked"]);
  });

  it("says so plainly when there are no pins", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture({ pins: [] }) });
    const reply = await specOf(mapGroup, "map pins").handler(ctx, input());
    expect(reply.embeds![0]!.toJSON().description).toMatch(/No pins/u);
  });
});

describe("/map pin", () => {
  it("drops the pin the options described", async () => {
    let got: unknown;
    const ctx = ctxWith({ dropPin: async (_id: string, p: unknown) => { got = p; return { ok: true, id: 5 }; } });
    const reply = await specOf(mapGroup, "map pin").handler(ctx, input({ x: 4200, z: 8100, icon: "loot", note: "crates" }));
    expect(got).toEqual({ x: 4200, z: 8100, icon: "loot", note: "crates" });
    expect(reply.content).toBe(PIN_RESULT_COPY.dropped);
  });

  it("sends a blank note as null, not as an empty string", async () => {
    let got: { note: string | null } | undefined;
    const ctx = ctxWith({ dropPin: async (_id: string, p: { note: string | null }) => { got = p; return { ok: true, id: 5 }; } });
    await specOf(mapGroup, "map pin").handler(ctx, input({ x: 1, z: 2, icon: "note" }));
    expect(got!.note).toBeNull();
  });

  it("answers a refusal in the map's own words", async () => {
    const ctx = ctxWith({ dropPin: async () => ({ ok: false, reason: "off-map" }) });
    const reply = await specOf(mapGroup, "map pin").handler(ctx, input({ x: 1, z: 2, icon: "loot" }));
    expect(reply.content).toBe(PIN_RESULT_COPY["off-map"]);
  });

  it("offers the six icons as choices, not as free text", () => {
    const sub = mapGroup.command.toJSON().options!.find((o) => o.name === "pin")!;
    const icon = ((sub as { options?: { name: string; choices?: unknown[] }[] }).options ?? []).find((o) => o.name === "icon")!;
    expect(icon.choices).toHaveLength(6);
  });
});

describe("/map unpin", () => {
  it("deletes the pin the option named", async () => {
    let got: number | undefined;
    const ctx = ctxWith({ deletePin: async (_id: string, pinId: number) => { got = pinId; return { deleted: true }; } });
    const reply = await specOf(mapGroup, "map unpin").handler(ctx, input({ pin: "7" }));
    expect(got).toBe(7);
    expect(reply.content).toBe(PIN_RESULT_COPY.deleted);
  });

  it("says so when the pin was not the actor's to delete", async () => {
    const ctx = ctxWith({ deletePin: async () => ({ deleted: false }) });
    const reply = await specOf(mapGroup, "map unpin").handler(ctx, input({ pin: "7" }));
    expect(reply.content).toBe(PIN_RESULT_COPY["not-deleted"]);
  });

  /** ⚠️ R6: an autocomplete list is rendered while the player types, possibly on a shared screen. */
  it("offers pins by icon, note and age — never by coordinate", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture({ pins: [pin({ id: 3, x: 4200, z: 8100, note: "crates" })] }) });
    const choices = await sourceOf(mapGroup, "map unpin", "pin")(ctx, { actorDiscordId: "111", value: "" });
    expect(choices).toHaveLength(1);
    expect(choices[0]!.value).toBe("3");
    expect(choices[0]!.name).toContain("crates");
    expect(choices[0]!.name).not.toContain("4200");
    expect(choices[0]!.name).not.toContain("8100");
  });
});

describe("/map view", () => {
  it("answers with the link and nothing else — the map is a picture", async () => {
    const reply = await specOf(mapGroup, "map view").handler(ctxWith({}), input());
    expect(reply.content).toContain("https://x/map");
    expect(reply.embeds).toBeUndefined();
  });
});
