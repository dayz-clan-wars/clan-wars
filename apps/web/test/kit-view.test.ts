import { describe, it, expect } from "vitest";
import type { BoosterKitView } from "@factions/roster";
import { KIT_SLOTS, type KitSlot } from "@factions/domain";
import { kitView } from "../lib/kit-view";

const EMPTY = Object.fromEntries(KIT_SLOTS.map((s) => [s, null])) as Record<KitSlot, string | null>;

const view = (over: Partial<BoosterKitView> = {}): BoosterKitView => ({
  boosting: true,
  linked: { gamertag: "Wintershadow394" },
  slots: EMPTY,
  spot: null,
  armband: null,
  challenge: null,
  ...over,
});

describe("the kit page's view", () => {
  it("flattens the link to the gamertag the page prints, or null", () => {
    expect(kitView(view()).gamertag).toBe("Wintershadow394");
    expect(kitView(view({ linked: null })).gamertag).toBeNull();
  });

  /**
   * ⚠️ The page speaks in grid squares, like /base and /map. It has no use
   * for metres, and a coordinate in a JSON body is a coordinate in the
   * browser's network log.
   */
  it("gives the spot as a grid square and a map link, never as metres", () => {
    const out = kitView(view({ spot: { x: 7450, y: 210, z: 5280, placedAt: new Date() } }));
    expect(out.spot).not.toBeNull();
    expect(out.spot!.grid).toBe("074 052");
    expect(out.spot!.href).toBe("/map?at=074052");
    expect(JSON.stringify(out)).not.toContain("7450");
  });

  /**
   * ⚠️ The town name is why this is built on the server: `nearestPlace` walks
   * lib/map-places.json, and shipping that to the client would put a second
   * copy of the world's geometry in the bundle of a page that needs one word.
   */
  it("names the nearest settlement to the spot", () => {
    expect(kitView(view({ spot: { x: 7450, y: 210, z: 5280, placedAt: null } })).spot!.near).toBe("Roztoka");
  });

  it("has no spot at all when none has been marked", () => {
    expect(kitView(view()).spot).toBeNull();
  });

  /**
   * ⚠️ Every Date is already a string. The page is a client component fed by
   * fetch, so a Date would survive the first render and become a string on
   * the first poll, and the countdown would start throwing an hour in.
   */
  it("hands the sequence over with its expiry as a string, and the steps as the server marked them", () => {
    const expiresAt = new Date("2026-09-20T12:00:00.000Z");
    const out = kitView(view({
      challenge: {
        id: 4,
        confirmed: 1,
        steps: [
          { token: "salute", label: "salute", confirmed: true },
          { token: "facepalm", label: "facepalm", confirmed: false },
        ],
        expiresAt,
      },
    }));
    expect(out.challenge).toEqual({
      id: 4,
      confirmed: 1,
      steps: [
        { token: "salute", label: "salute", confirmed: true },
        { token: "facepalm", label: "facepalm", confirmed: false },
      ],
      expiresAt: "2026-09-20T12:00:00.000Z",
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("carries the nine picks through untouched", () => {
    const slots = { ...EMPTY, jacket: "GorkaEJacket_Summer" };
    expect(kitView(view({ slots })).slots).toEqual(slots);
  });

  /**
   * ⚠️ The armband is derived from the clan's flag every read and the page
   * has no tile for it. It must not ride the payload either.
   */
  it("does not carry the armband to the page", () => {
    const out = kitView(view({ armband: { className: "Armband_Red", texture: "Flag_Red", clanName: "Red", clanTag: "RED" } }));
    expect(JSON.stringify(out)).not.toContain("Armband_Red");
  });
});
