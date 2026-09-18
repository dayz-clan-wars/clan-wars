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

  /**
   * ⚠️ Deliberate behaviour change: an open challenge no longer exempts an
   * unbanned player. They are banned now and LIFTED on a later pass, once the
   * ban is applied. The old rule (return "none" here) meant a ban was never
   * written while a challenge was open, so `liftSpent` never became true and a
   * player could re-roll a fresh 24 h challenge forever — the gate never fired.
   */
  it("bans someone mid-link, to be lifted once the ban is applied", () => {
    expect(pcGateAction(facts({ challengeOpen: true }))).toBe("ban");
  });

  /**
   * ⚠️ The corner the old rule hid, both ways round: an unbanned desktop
   * player mid-link is banned whether or not their one lift is already spent.
   * This is the renewing-exemption case — if either of these returned "none",
   * a re-rolled challenge would be a permanent exemption.
   */
  it("bans an unlinked desktop player with an open challenge and no active ban", () => {
    expect(pcGateAction(facts({ challengeOpen: true, activeBan: false, liftSpent: false }))).toBe("ban");
    expect(pcGateAction(facts({ challengeOpen: true, activeBan: false, liftSpent: true }))).toBe("ban");
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
