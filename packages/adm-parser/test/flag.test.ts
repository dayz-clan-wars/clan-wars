import { describe, it, expect } from "vitest";
import { parseFlagChange } from "../src/index.js";

const RAISED =
  '05:17:25 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 ' +
  'pos=<2992.5, 1137.4, 448.1>) has raised Flag_Livonia on TerritoryFlag ' +
  'at <2991.569092, 447.946503, 1138.587646>';

const LOWERED =
  '18:25:04 | Player "kpolanco1834" (id=DA18FD2AB3A071758A5B3BA8397C1E5307DF91AB ' +
  'pos=<2993.1, 1137.3, 447.9>) has lowered Flag_Bohemia on TerritoryFlag ' +
  'at <2991.569092, 447.946503, 1138.587646>';

describe("parseFlagChange", () => {
  it("parses a raise", () => {
    expect(parseFlagChange(RAISED)).toEqual({
      gamertag: "XxBE4zyxX",
      dayzId: "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1",
      action: "raised",
      texture: "Flag_Livonia",
      player: { x: 2992.5, y: 448.1, z: 1137.4 },
      pole: { x: 2991.569092, y: 447.946503, z: 1138.587646 },
    });
  });

  it("parses a lower", () => {
    const r = parseFlagChange(LOWERED);
    expect(r?.action).toBe("lowered");
    expect(r?.texture).toBe("Flag_Bohemia");
  });

  it("keeps the full texture class name including the Flag_ prefix", () => {
    expect(parseFlagChange(RAISED)?.texture).toBe("Flag_Livonia");
  });

  it("gives the same pole coords for both events at one pole", () => {
    expect(parseFlagChange(RAISED)?.pole).toEqual(parseFlagChange(LOWERED)?.pole);
  });

  it("parses multi-word textures such as Flag_LivoniaPolice", () => {
    const raw = RAISED.replace("Flag_Livonia", "Flag_LivoniaPolice");
    expect(parseFlagChange(raw)?.texture).toBe("Flag_LivoniaPolice");
  });

  it("returns null on a flagpole build line", () => {
    expect(parseFlagChange('Player "A" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 pos=<1.0, 2.0, 3.0>)Built base on Flag Pole with Sledgehammer')).toBeNull();
  });

  it("returns null on a non-flag line", () => {
    expect(parseFlagChange('Player "A" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1) is connected')).toBeNull();
  });

  it("returns null when the pole coords are missing", () => {
    expect(parseFlagChange('Player "A" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 pos=<1.0, 2.0, 3.0>) has raised Flag_DayZ on TerritoryFlag')).toBeNull();
  });
});
