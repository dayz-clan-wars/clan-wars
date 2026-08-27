import { describe, it, expect } from "vitest";
import { parseLine, eventTypeFor } from "../src/index.js";

const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";
const RAISED =
  `05:17:25 | Player "XxBE4zyxX" (id=${ID} pos=<2992.5, 1137.4, 448.1>) ` +
  "has raised Flag_Livonia on TerritoryFlag at <2991.569092, 447.946503, 1138.587646>";

describe("parseLine", () => {
  it("yields the flag change before anything else", () => {
    const out = parseLine(RAISED);
    expect(out[0]?.kind).toBe("flag");
  });

  it("does not emit a position entry for a flag line", () => {
    // The flag change already carries the player position; a second entry would be redundant.
    expect(parseLine(RAISED).filter((l) => l.kind === "position")).toHaveLength(0);
  });

  it("yields a position entry for a PlayerList body line", () => {
    const raw = `13:00:07 | Player "LowerMarrow774" (id=${ID} pos=<9958.4, 7440.6, 176.4>)`;
    const out = parseLine(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: "position",
      gamertag: "LowerMarrow774",
      dayzId: ID,
      pos: { x: 9958.4, y: 176.4, z: 7440.6 },
    });
  });

  it("yields a roster entry for the dump header", () => {
    expect(parseLine("13:00:07 | ##### PlayerList log: 2 players")).toEqual([{ kind: "roster", count: 2 }]);
  });

  it("yields a flagpole entry for a fold", () => {
    const raw = `09:18:49 | Player "A" (id=${ID} pos=<12469.7, 2387.5, 9.5>) folded Flag Pole`;
    expect(parseLine(raw)[0]?.kind).toBe("flagpole");
  });

  it("yields nothing for an unrelated line", () => {
    expect(parseLine(`10:00:00 | Player "A" (id=${ID}) is connected`)).toEqual([]);
  });

  it("routes an emote line to the emote branch", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${"A".repeat(40)} pos=<1.0, 2.0, 3.0>) performed EmoteSalute`;
    const out = parseLine(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("emote");
    expect(eventTypeFor(out[0]!)).toBe("emote.performed");
  });

  it("keeps an emote line at subIndex 0", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${"A".repeat(40)} pos=<1.0, 2.0, 3.0>) performed EmoteClap`;
    // subIndex is the array index; a single-element array pins it at 0.
    expect(parseLine(raw)).toHaveLength(1);
  });

  it("does not let the PlayerList entry matcher claim an emote line", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${"A".repeat(40)} pos=<1.0, 2.0, 3.0>) performed EmoteClap`;
    expect(parseLine(raw)[0]?.kind).not.toBe("position");
  });
});

describe("eventTypeFor", () => {
  it("maps a raise", () => {
    expect(eventTypeFor(parseLine(RAISED)[0]!)).toBe("flag.raised");
  });
  it("maps a fold", () => {
    const raw = `09:18:49 | Player "A" (id=${ID} pos=<12469.7, 2387.5, 9.5>) folded Flag Pole`;
    expect(eventTypeFor(parseLine(raw)[0]!)).toBe("flagpole.folded");
  });
  it("maps a position", () => {
    const raw = `13:00:07 | Player "A" (id=${ID} pos=<9958.4, 7440.6, 176.4>)`;
    expect(eventTypeFor(parseLine(raw)[0]!)).toBe("player.position");
  });
  it("returns null for a roster header, which is not persisted", () => {
    expect(eventTypeFor({ kind: "roster", count: 2 })).toBeNull();
  });
});
