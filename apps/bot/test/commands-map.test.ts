import { describe, it, expect } from "vitest";
import { PIN_RESULT_COPY } from "@factions/copy";
import { mapGroup } from "../src/commands/map.js";
import { ctxWith, input, sourceOf, specOf } from "./command-fakes.js";
import type { MapState } from "@factions/roster";

const pin = (over: Partial<MapState["pins"][number]> = {}): MapState["pins"][number] => ({
  id: 1, x: 4200, z: 8100, icon: "loot", note: "crates", by: "Ada",
  at: new Date("2026-09-12T10:00:00Z"), expiresAt: new Date("2026-09-19T10:00:00Z"), ...over,
});

/**
 * ⚠️ EVERY forbidden field carries a distinctive value, on purpose. A
 * fixture that leaves `clanmates`, `base`, `you.fix` or `travelPoints` empty
 * makes the "never renders" test below pass vacuously: a future field that
 * rendered a clanmate's position, the viewer's own base or the hub would sail
 * through it. The strings and numbers here appear nowhere else in the file,
 * so any one of them reaching the card fails the test by name.
 */
const mapFixture = (over: Partial<MapState> = {}): MapState => ({
  world: { size: 12800 },
  you: { gamertag: "Ada", fix: { x: 7771, z: 7772, at: new Date("2026-09-12T09:00:00Z") } },
  base: { x: 6661, z: 6662, radiusM: 50, kind: "clan" },
  clanmates: [{ dayzId: "mate-1", gamertag: "Bex", fix: { x: 5551, z: 5552, at: new Date("2026-09-12T09:30:00Z") } }],
  intruders: [{ gamertag: "Rat", x: 4441, z: 4442, lastSeenAt: new Date("2026-09-12T09:45:00Z"), distanceM: 300 }],
  publicBases: [{ x: 3331, z: 3332 }],
  pins: [pin()],
  bounties: [{ gamertag: "Fugitive", reason: "smoked the whole clan", fix: { x: 9991, z: 9992, at: new Date("2026-09-12T09:15:00Z") } }],
  travelPoints: [{ x: 2221, z: 2222 }],
  hub: { x: 1111, z: 1112 },
  layers: { base: true, clanmates: true, intruders: true, pins: true },
  ...over,
});

/** Every value in `mapFixture` that no reply may ever carry. */
const FORBIDDEN = ["Rat", "wolf", "Bex", "mate-1", "7771", "7772", "6661", "6662", "5551", "5552", "4441", "4442", "3331", "3332", "2221", "2222", "1111", "1112", "Fugitive", "smoked the whole clan", "9991", "9992"];

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
   * `MapState` also carries intruders, other clans' declared bases, and
   * clanmates' live position fixes. Every one of those is a raid target, and
   * the site draws them only inside its own gated map view; no Discord reply
   * may carry any of them.
   */
  it("renders nothing from MapState but the clan's own pins", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture() });
    const reply = await specOf(mapGroup, "map pins").handler(ctx, input());
    const rendered = JSON.stringify(reply.embeds![0]!.toJSON());
    for (const secret of FORBIDDEN) expect(rendered, `${secret} reached the card`).not.toContain(secret);
  });

  /** ⚠️ The autocomplete label is read while the player types, possibly on a shared screen (R6). */
  it("renders nothing forbidden in an autocomplete label either", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture() });
    const choices = await sourceOf(mapGroup, "map unpin", "pin")(ctx, { actorDiscordId: "111", value: "" });
    const rendered = JSON.stringify(choices);
    for (const secret of FORBIDDEN) expect(rendered, `${secret} reached a label`).not.toContain(secret);
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

  /**
   * ⚠️ `by: null` — a real, reachable state (the author `/unlink`ed or left
   * while the pin was still inside its TTL) — must render as bold plain
   * text, never a link. `playerLink` on a null gamertag would produce a
   * clickable link to a player page that can never resolve.
   */
  it("renders a pin author gone from the roster as bold text, not a dead link", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture({ pins: [pin({ by: null })] }) });
    const reply = await specOf(mapGroup, "map pins").handler(ctx, input());
    const value = reply.embeds![0]!.toJSON().fields?.[0]?.value ?? "";
    expect(value).toContain("**a member**");
    expect(value).not.toContain("](<");
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

  /**
   * ⚠️ Unreachable through a real client — Discord enforces required options
   * — but the reply must still name the right problem. Answering "That point
   * is off the map" for coordinates that never arrived describes a refusal
   * that never happened.
   */
  it("asks for a point rather than claiming one was off the map", async () => {
    const ctx = ctxWith({ dropPin: async () => { throw new Error("must not be called"); } });
    const reply = await specOf(mapGroup, "map pin").handler(ctx, input({ icon: "loot" }));
    expect(reply.content).toMatch(/Give an x/u);
    expect(reply.content).not.toBe(PIN_RESULT_COPY["off-map"]);
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

  /** ⚠️ Same rule as `/map pin` above: a missing option is bad input, not a real refusal. */
  it("asks for a pin rather than claiming it was not the actor's", async () => {
    const ctx = ctxWith({ deletePin: async () => { throw new Error("must not be called"); } });
    const reply = await specOf(mapGroup, "map unpin").handler(ctx, input());
    expect(reply.content).toMatch(/Pick a pin/u);
    expect(reply.content).not.toBe(PIN_RESULT_COPY["not-deleted"]);
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

  /** ⚠️ A bare URL in plain content unfurls a preview card — mask it in the house form. */
  it("masks the map link so Discord never unfurls a preview card beneath it", async () => {
    const reply = await specOf(mapGroup, "map view").handler(ctxWith({}), input());
    expect(reply.content).toBe("The map is a picture — [open it here](<https://x/map>)");
  });
});
