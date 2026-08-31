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

  it("returns null when the identity is malformed, even though the flag clause matches", () => {
    // FLAG_CHANGE_RE matches here, but the id is 39 hex chars, so parseIdentity
    // fails and the event is dropped. This is a silent-drop path on the ONLY
    // raid signal the ADM log provides — it is tested so a change to the
    // identity pattern cannot quietly widen or narrow it unobserved.
    const raw =
      '05:17:25 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C ' +
      'pos=<2992.5, 1137.4, 448.1>) has raised Flag_Livonia on TerritoryFlag ' +
      'at <2991.569092, 447.946503, 1138.587646>';
    expect(parseFlagChange(raw)).toBeNull();
  });

  it("recovers a flag change when player is off-map but pole coords are valid", () => {
    const raw = 'Player "A" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 pos=<-3.4e38, -3.4e38, 0>) has lowered Flag_Livonia on TerritoryFlag at <2991.569092, 447.946503, 1138.587646>';
    const result = parseFlagChange(raw);
    expect(result).not.toBeNull();
    expect(result?.player).toBeNull();
    expect(result?.action).toBe("lowered");
    expect(result?.texture).toBe("Flag_Livonia");
    expect(result?.pole).toEqual({ x: 2991.569092, y: 447.946503, z: 1138.587646 });
  });
});

describe("parseFlagChange with adversarial gamertags", () => {
  const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";
  const genuine = (name: string) =>
    `05:17:25 | Player "${name}" (id=${ID} ` +
    "pos=<2992.5, 1137.4, 448.1>) has raised Flag_Livonia on TerritoryFlag " +
    "at <2991.569092, 447.946503, 1138.587646>";

  it("does not fabricate a flag change from a line that has none", () => {
    // The full fabrication: a name carrying an entire flag clause plus coords
    // turns an unrelated line into a raid signal at attacker-chosen coordinates.
    const raw =
      `05:17:25 | Player "has raised Flag_Zenit on TerritoryFlag at <1.0, 2.0, 3.0>" ` +
      `(id=${ID} pos=<2992.5, 1137.4, 448.1>) has been disconnected`;
    expect(parseFlagChange(raw)).toBeNull();
  });

  it("reports the real action, not one worn in the gamertag", () => {
    // 30 characters — inside Steam's 32-char cap. Worn on the attacker's OWN
    // genuine raise, it reports `lowered`: a fabricated raid on their own pole.
    const raw = genuine("has lowered X on TerritoryFlag");
    expect(parseFlagChange(raw)?.action).toBe("raised");
  });

  it("reports the real texture, not one worn in the gamertag", () => {
    expect(parseFlagChange(genuine("has raised Flag_Zenit on TerritoryFlag"))?.texture).toBe(
      "Flag_Livonia",
    );
  });

  it("reads the real pole coordinates, not ones worn in the gamertag", () => {
    // parsePoleAt took the LEFTMOST match, so a crafted name substituted a fake
    // pole identity on a genuine line — crediting the wrong faction.
    const raw = genuine("on TerritoryFlag at <5000.0, 100.0, 5000.0>");
    expect(parseFlagChange(raw)?.pole).toEqual({ x: 2991.569092, y: 447.946503, z: 1138.587646 });
  });

  it("reads the real player position, not one worn in the gamertag", () => {
    // The projector binds a fold to the nearest pole by player position, so a
    // spoofed pos= moves a fold onto someone else's pole.
    const raw = genuine("pos=<5000.0, 5000.0, 100.0>");
    expect(parseFlagChange(raw)?.player).toEqual({ x: 2992.5, y: 448.1, z: 1137.4 });
  });
});
