import { describe, it, expect } from "vitest";
import { parsePlacement } from "../src/placement.js";
import { parseLine, eventTypeFor } from "../src/parse-line.js";

const ID = "A".repeat(40);

describe("parsePlacement", () => {
  it("parses a fireplace placement with the classname and the player position", () => {
    const raw = `19:12:44 | Player "Popin 0ps" (id=${ID} pos=<12470.7, 2386.4, 9.5>) placed Fireplace<Fireplace>`;
    expect(parsePlacement(raw)).toEqual({
      gamertag: "Popin 0ps", dayzId: ID, item: "Fireplace", itemClass: "Fireplace",
      pos: { x: 12470.7, y: 9.5, z: 2386.4 },
    });
  });

  it("parses a garden plot, whose DISPLAY NAME is useless", () => {
    // ⚠️ Observed verbatim in DayZServer_X1_x64_2026-09-15_11-01-51.ADM. A garden
    // plot logs its display name as "Nameless Object" — which is precisely why
    // detection keys on the CLASSNAME in the angle brackets and never on the
    // display name. Do not "fix" this test to say "Garden Plot".
    const raw = `11:58:12 | Player "Sasha" (id=${ID} pos=<9727.9, 8545.3, 214.3>) placed Nameless Object<GardenPlot>`;
    expect(parsePlacement(raw)).toMatchObject({ item: "Nameless Object", itemClass: "GardenPlot" });
  });

  it("parses a fireplace", () => {
    // Observed verbatim in DayZServer_X1_x64_2026-09-14_19-01-58.ADM.
    const raw = `19:58:00 | Player "Sasha" (id=${ID} pos=<2523.7, 12605.6, 304.8>) placed Fireplace<Fireplace>`;
    expect(parsePlacement(raw)).toMatchObject({ item: "Fireplace", itemClass: "Fireplace" });
  });

  it("parses a classname carrying an underscore", () => {
    // `Barrel_Blue` is real and observed; \w+ must cover it even though barrels
    // are not currently in BOOST_ITEM_CLASSES.
    const raw = `11:47:20 | Player "Sasha" (id=${ID} pos=<10774.3, 12572.5, 228.0>) placed Barrel<Barrel_Blue>`;
    expect(parsePlacement(raw)).toMatchObject({ item: "Barrel", itemClass: "Barrel_Blue" });
  });

  it("a gamertag carrying placement-shaped text cannot forge an event", () => {
    // The `placed X<Y>` text sits BEFORE the identity block, worn in the name.
    const raw = `19:12:44 | Player "X) placed Fireplace<Fireplace>" (id=${ID} pos=<100.0, 200.0, 12.0>) has connected`;
    expect(parsePlacement(raw)).toBeNull();
  });

  it("a line with no identity block is not a placement", () => {
    expect(parsePlacement(`19:12:44 | placed Fireplace<Fireplace>`)).toBeNull();
  });

  it("a flag pole kit still yields flagpole.placed, not item.placed", () => {
    const raw = `19:12:44 | Player "Popin 0ps" (id=${ID} pos=<12470.7, 2386.4, 9.5>) placed Flag Pole Kit<TerritoryFlagKit>`;
    const [line] = parseLine(raw);
    expect(line!.kind).toBe("flagpole");
    expect(eventTypeFor(line!)).toBe("flagpole.placed");
  });

  it("parseLine maps a fireplace to item.placed", () => {
    const raw = `19:12:44 | Player "Sasha" (id=${ID} pos=<100.0, 200.0, 12.0>) placed Fireplace<Fireplace>`;
    const [line] = parseLine(raw);
    expect(line!.kind).toBe("placement");
    expect(eventTypeFor(line!)).toBe("item.placed");
  });
});
