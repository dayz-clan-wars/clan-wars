import { describe, it, expect } from "vitest";
import { parseIdentity } from "../src/index.js";

describe("parseIdentity", () => {
  it("extracts gamertag and 40-hex uid", () => {
    const raw = '12:55:19 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 pos=<1.0, 2.0, 3.0>) has raised Flag_DayZ';
    expect(parseIdentity(raw)).toEqual({
      gamertag: "XxBE4zyxX",
      dayzId: "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1",
    });
  });

  it("handles gamertags containing spaces", () => {
    const raw = '10:59:52 | Player "Cee Lo GREEN 96" (id=7B1D53CE555E30DD016FBFBA9BCA0AFFD565BEB4) is connected';
    expect(parseIdentity(raw)?.gamertag).toBe("Cee Lo GREEN 96");
  });

  it("returns null when the id is not 40 hex characters", () => {
    expect(parseIdentity('Player "A" (id=SHORT pos=<1.0, 2.0, 3.0>)')).toBeNull();
  });

  it("returns null on a line with no player clause", () => {
    expect(parseIdentity("13:00:07 | ##### PlayerList log: 2 players")).toBeNull();
  });
});
