import { describe, it, expect } from "vitest";
import { bunkerRoomName } from "../src/retired-airdrops.js";

describe("bunkerRoomName", () => {
  it("names a current keycard room", () => {
    expect(bunkerRoomName("kamensk-military")).toBe("Kamensk Military");
    expect(bunkerRoomName("nwaf")).toBe("NWAF");
  });
  it("names a retired Livonia airdrop location by capitalising its slug", () => {
    expect(bunkerRoomName("tarnow")).toBe("Tarnow");
    expect(bunkerRoomName("dolnik")).toBe("Dolnik");
  });
  it("falls back to the slug for anything unknown", () => {
    expect(bunkerRoomName("narnia")).toBe("narnia");
  });
});
