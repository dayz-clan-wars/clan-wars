import { describe, test, expect } from "vitest";
import { REDACTED_PLAYER_RE, REDACTED_CLAN_RE, isRedactedAlias, redactedSpokenForms } from "../../../src/engine/audio/redactedSpeech.js";

describe("REDACTED_PLAYER_RE / REDACTED_CLAN_RE", () => {
  test("match the exact redacted alias shape", () => {
    expect(REDACTED_PLAYER_RE.test("REDACTED_PLAYER_1")).toBe(true);
    expect(REDACTED_CLAN_RE.test("REDACTED_CLAN_2")).toBe(true);
  });
});

describe("isRedactedAlias", () => {
  test("true for a player or clan alias", () => {
    expect(isRedactedAlias("REDACTED_PLAYER_1")).toBe(true);
    expect(isRedactedAlias("REDACTED_CLAN_1")).toBe(true);
  });
  test("false for a near-miss with trailing junk", () => {
    expect(isRedactedAlias("REDACTED_PLAYER_1x")).toBe(false);
  });
  test("false for a near-miss with leading junk", () => {
    expect(isRedactedAlias("xREDACTED_CLAN_1")).toBe(false);
  });
});

describe("redactedSpokenForms", () => {
  test("a single redacted player is spoken generically", () => {
    expect(redactedSpokenForms(["REDACTED_PLAYER_1"])).toEqual({
      REDACTED_PLAYER_1: "the player whose name we cannot say"
    });
  });

  test("two or more redacted players are numbered", () => {
    expect(redactedSpokenForms(["REDACTED_PLAYER_1", "REDACTED_PLAYER_2"])).toEqual({
      REDACTED_PLAYER_1: "player number 1 whose name we cannot say",
      REDACTED_PLAYER_2: "player number 2 whose name we cannot say"
    });
  });

  test("a redacted clan is always spoken the same way", () => {
    expect(redactedSpokenForms(["REDACTED_CLAN_1"])).toEqual({
      REDACTED_CLAN_1: "a clan we can't name on this network"
    });
  });

  test("duplicates in the input do not count as several", () => {
    expect(redactedSpokenForms(["REDACTED_PLAYER_1", "REDACTED_PLAYER_1"])).toEqual({
      REDACTED_PLAYER_1: "the player whose name we cannot say"
    });
  });
});
