import { describe, it, expect } from "vitest";
import { pcGateAction, type PcGateFacts } from "../src/pc-gate";

const facts = (over: Partial<PcGateFacts> = {}): PcGateFacts => ({
  seenOnDesktop: true, linked: false, challengeOpen: false, activeBan: false, liftSpent: false, ...over,
});

describe("pcGateAction", () => {
  it("bans an unlinked desktop player who is not mid-link", () => {
    expect(pcGateAction(facts())).toBe("ban");
  });

  it("does nothing to a console player, whatever else is true", () => {
    expect(pcGateAction(facts({ seenOnDesktop: false }))).toBe("none");
    expect(pcGateAction(facts({ seenOnDesktop: false, linked: false, activeBan: true }))).toBe("none");
  });

  it("does nothing to a linked desktop player", () => {
    expect(pcGateAction(facts({ linked: true }))).toBe("none");
  });

  it("does not ban someone mid-link", () => {
    expect(pcGateAction(facts({ challengeOpen: true }))).toBe("none");
  });

  it("lifts for a banned player who has started linking", () => {
    expect(pcGateAction(facts({ challengeOpen: true, activeBan: true }))).toBe("lift");
  });

  /** ⚠️ The abuse vector: start a link, get unbanned, never finish, repeat forever. */
  it("refuses a second lift, for all time", () => {
    expect(pcGateAction(facts({ challengeOpen: true, activeBan: true, liftSpent: true }))).toBe("none");
  });

  it("does not ban twice while a ban is already active", () => {
    expect(pcGateAction(facts({ activeBan: true }))).toBe("none");
  });

  it("re-bans after a challenge lapsed and the lift was spent", () => {
    expect(pcGateAction(facts({ liftSpent: true }))).toBe("ban");
  });
});
