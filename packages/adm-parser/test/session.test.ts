import { describe, it, expect } from "vitest";
import { parseSession } from "../src/session.js";

const ID = "C".repeat(40);

describe("parseSession", () => {
  it("reads a connect line", () => {
    expect(parseSession(`10:00:00 | Player "Steve" (id=${ID}) is connected`))
      .toEqual({ kind: "connected", dayzId: ID, gamertag: "Steve" });
  });

  it("reads a disconnect line", () => {
    expect(parseSession(`10:00:00 | Player "Steve" (id=${ID}) has been disconnected`))
      .toEqual({ kind: "disconnected", dayzId: ID, gamertag: "Steve" });
  });

  it("returns null for 'is connecting', which is not a completed connect", () => {
    expect(parseSession(`10:00:00 | Player "Steve" (id=${ID}) is connecting`)).toBeNull();
  });

  it("returns null for a PlayerList body line", () => {
    expect(parseSession(`13:00:07 | Player "Steve" (id=${ID} pos=<9958.4, 7440.6, 176.4>)`)).toBeNull();
  });

  it("⚠️ returns null for a gamertag containing 'is connected' on an emote line", () => {
    const raw = `10:00:00 | Player "x is connected" (id=${ID} pos=<1.0, 2.0, 3.0>) performed EmoteSalute`;
    expect(parseSession(raw)).toBeNull();
  });
});
