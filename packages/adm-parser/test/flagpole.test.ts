import { describe, it, expect } from "vitest";
import { parseFlagPole } from "../src/index.js";

const ID = "7D7BE4A8627CF9B969DA293B3A72F3369DFD8D8E";

describe("parseFlagPole", () => {
  it("parses a placed flag pole kit", () => {
    const raw = `19:12:44 | Player "Popin 0ps" (id=${ID} pos=<12470.7, 2386.4, 9.5>) placed Flag Pole Kit<TerritoryFlagKit>`;
    expect(parseFlagPole(raw)).toEqual({
      gamertag: "Popin 0ps",
      dayzId: ID,
      action: "placed_kit",
      part: null,
      tool: null,
      player: { x: 12470.7, y: 9.5, z: 2386.4 },
    });
  });

  it("parses a folded flag pole", () => {
    const raw = `09:18:49 | Player "Popin 0ps" (id=${ID} pos=<12469.7, 2387.5, 9.5>) folded Flag Pole`;
    const r = parseFlagPole(raw);
    expect(r?.action).toBe("folded");
    expect(r?.part).toBeNull();
  });

  it("parses a build step, capturing part and tool", () => {
    // NOTE: real logs have NO space between ')' and 'Built'.
    const raw = `09:32:26 | Player "XxBE4zyxX" (id=${ID} pos=<2992.5, 1137.1, 447.9>)Built base on Flag Pole with Sledgehammer`;
    const r = parseFlagPole(raw);
    expect(r?.action).toBe("built");
    expect(r?.part).toBe("base");
    expect(r?.tool).toBe("Sledgehammer");
  });

  it("parses a dismantle step", () => {
    const raw = `12:24:32 | Player "Popin 0ps" (id=${ID} pos=<12469.0, 2387.6, 9.4>)Dismantled Base from Flag Pole with Sledgehammer`;
    const r = parseFlagPole(raw);
    expect(r?.action).toBe("dismantled");
    expect(r?.part).toBe("Base");
    expect(r?.tool).toBe("Sledgehammer");
  });

  it("parses a fold with no parseable position as player: null", () => {
    // Off-map sentinel position: the fold still happened and must still be
    // recorded, but there is no position to bind it to a pole with. This null
    // is the exact input to the projector's unbound-fold path.
    const sentinel = "-340282346638528859811704183484516925440.0";
    const raw = `09:18:49 | Player "Popin 0ps" (id=${ID} pos=<${sentinel}, ${sentinel}, 0.0>) folded Flag Pole`;
    const r = parseFlagPole(raw);
    expect(r).not.toBeNull();
    expect(r?.action).toBe("folded");
    expect(r?.player).toBeNull();
    expect(r?.dayzId).toBe(ID);
  });

  it("returns null for a raise, which is a flag change not a pole change", () => {
    const raw = `05:17:25 | Player "A" (id=${ID} pos=<1.0, 2.0, 3.0>) has raised Flag_Livonia on TerritoryFlag at <1.0, 3.0, 2.0>`;
    expect(parseFlagPole(raw)).toBeNull();
  });

  it("returns null for building a fence, which is not a flag pole", () => {
    const raw = `10:00:00 | Player "A" (id=${ID} pos=<1.0, 2.0, 3.0>)Built wall_base_down on Fence with Hammer`;
    expect(parseFlagPole(raw)).toBeNull();
  });
});
