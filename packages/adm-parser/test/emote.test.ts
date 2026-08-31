import { describe, it, expect } from "vitest";
import { parseEmote } from "../src/emote.js";

const UID = "A".repeat(40);

describe("parseEmote", () => {
  it("parses a bare emote line", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${UID} pos=<11201.5, 6703.0, 56.4>) performed EmoteSalute`;
    expect(parseEmote(raw)).toEqual({ gamertag: "Steve", dayzId: UID, emote: "EmoteSalute", item: null });
  });

  it("parses the 'with <item>' variant", () => {
    const raw = `| 18:58:20 | Player "Steve" (id=${UID} pos=<1.0, 2.0, 3.0>) performed EmoteSuicide with SteakKnife`;
    expect(parseEmote(raw)).toEqual({ gamertag: "Steve", dayzId: UID, emote: "EmoteSuicide", item: "SteakKnife" });
  });

  it("handles the (DEAD) identity variant", () => {
    const raw = `| 15:24:30 | Player "Steve" (DEAD) (id=${UID} pos=<1.0, 2.0, 3.0>) performed EmoteClap`;
    expect(parseEmote(raw)?.dayzId).toBe(UID);
  });

  it("handles a gamertag containing spaces and punctuation", () => {
    const raw = `| 15:24:30 | Player "Big Bad (Wolf)" (id=${UID} pos=<1.0, 2.0, 3.0>) performed EmoteDance`;
    const out = parseEmote(raw);
    expect(out?.gamertag).toBe("Big Bad (Wolf)");
    expect(out?.emote).toBe("EmoteDance");
  });

  it("does not capture the player position", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${UID} pos=<11201.5, 6703.0, 56.4>) performed EmoteSalute`;
    expect(JSON.stringify(parseEmote(raw))).not.toContain("11201");
  });

  it("returns null for a line with no identity", () => {
    expect(parseEmote("| 15:24:30 | performed EmoteSalute")).toBeNull();
  });

  it("returns null for a non-emote line", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${UID} pos=<1.0, 2.0, 3.0>) has raised Flag_White on TerritoryFlag at <1.0, 2.0, 3.0>`;
    expect(parseEmote(raw)).toBeNull();
  });

  it("returns null for an empty line", () => {
    expect(parseEmote("")).toBeNull();
  });

  describe("adversarial gamertags", () => {
    const HOSTILE = "x performed EmoteSalute with y";

    it("reports the real emote, not one embedded in the gamertag", () => {
      const raw = `| 1 | Player "${HOSTILE}" (id=${UID} pos=<1.0, 2.0, 3.0>) performed EmoteClap`;
      expect(parseEmote(raw)?.emote).toBe("EmoteClap");
    });

    it("does not turn a disconnect line into an emote event", () => {
      const raw = `| 1 | Player "${HOSTILE}" (id=${UID} pos=<1.0, 2.0, 3.0>) has been disconnected`;
      expect(parseEmote(raw)).toBeNull();
    });

    it("does not turn a kill line into an emote event", () => {
      const raw = `| 1 | Player "${HOSTILE}" (id=${UID} pos=<1.0, 2.0, 3.0>) killed by Player "Bob" (id=${"C".repeat(40)})`;
      expect(parseEmote(raw)).toBeNull();
    });

    it("never lets coordinates reach the item field", () => {
      const raw = `| 1 | Player "${HOSTILE}" (id=${UID} pos=<11201.5, 6703.0, 56.4>) performed EmoteSuicide with SteakKnife`;
      const out = parseEmote(raw);
      expect(out?.item).toBe("SteakKnife");
      expect(JSON.stringify(out)).not.toContain("11201");
      expect(JSON.stringify(out)).not.toContain("pos=");
    });

    it("does not leak a second player's UID into the item field", () => {
      const raw = `| 1 | Player "x performed EmoteDance with y" (id=${UID} pos=<1.0, 2.0, 3.0>) killed by Player "Bob" (id=${"C".repeat(40)})`;
      expect(JSON.stringify(parseEmote(raw))).not.toContain("C".repeat(40));
    });
  });
});
