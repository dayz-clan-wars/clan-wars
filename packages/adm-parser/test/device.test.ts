import { describe, it, expect } from "vitest";
import { parseDevices } from "../src/device.js";

const DESKTOP = [
  `17:03:01.672 [StateMachine]: Player xARESx7256 (dpnid 1739924331 uid ) Entering AuthPlayerLoginState`,
  `17:03:03.313  LOGINQUEUE   : Player 1739924331 updated with device type 'desktop'`,
  `17:03:03.313  NETWORK      : Notified of player 1739924331 using device 'desktop' (not headless)`,
  `17:03:05.31  [StateMachine]: Player xARESx7256 (dpnid 1739924331 uid A9DDCCFAF1B79A6ADE0757193F49647B10A60913) Entering DBGetLoginTimeLoginState`,
].join("\n");

const CONSOLE = [
  `17:02:57.100 [StateMachine]: Player SomeGamer99 (dpnid 1858954623 uid ) Entering AuthPlayerLoginState`,
  `17:02:59.532  LOGINQUEUE   : Player 1858954623 updated with device type 'console'`,
  `17:02:59.532  NETWORK      : Notified of player 1858954623 using device 'console' (headless)`,
  `17:03:00.010 [StateMachine]: Player SomeGamer99 (dpnid 1858954623 uid 75E109C86EABE1E14F7ACE47F2C9BF11757ACE0C) Entering DBGetLoginTimeLoginState`,
].join("\n");

describe("parseDevices", () => {
  it("reads a desktop player's uid, gamertag and device", () => {
    expect(parseDevices(DESKTOP)).toEqual([
      { dayzId: "A9DDCCFAF1B79A6ADE0757193F49647B10A60913", gamertag: "xARESx7256", device: "desktop" },
    ]);
  });

  it("reads a console player the same way", () => {
    expect(parseDevices(CONSOLE)).toEqual([
      { dayzId: "75E109C86EABE1E14F7ACE47F2C9BF11757ACE0C", gamertag: "SomeGamer99", device: "console" },
    ]);
  });

  /**
   * ⚠️ The device line is written BEFORE the uid is known. A parser that
   * reads the uid off the nearest StateMachine line above it gets "".
   */
  it("resolves the uid from the LATER StateMachine line, never the empty one above", () => {
    const [only] = parseDevices(DESKTOP);
    expect(only!.dayzId).toBe("A9DDCCFAF1B79A6ADE0757193F49647B10A60913");
  });

  /**
   * ⚠️ Four of these exist in the retained logs: the player's login began in
   * the previous file, so this one has a device line and no StateMachine
   * line to resolve it. Not knowing a device must never become a ban.
   */
  it("drops a device line whose dpnid never resolves to a uid", () => {
    const straddling = `17:02:59.532  LOGINQUEUE   : Player 999999 updated with device type 'desktop'`;
    expect(parseDevices(straddling)).toEqual([]);
  });

  it("returns one sighting per player, not one per device line", () => {
    const twice = DESKTOP + "\n" + `17:05:00.000  LOGINQUEUE   : Player 1739924331 updated with device type 'desktop'`;
    expect(parseDevices(twice)).toHaveLength(1);
  });

  /** ⚠️ An unrecognised device must read as "not PC", so it is not emitted at all. */
  it("ignores a device string that is neither console nor desktop", () => {
    const odd = [
      `17:02:57.100 [StateMachine]: Player Future1 (dpnid 4242 uid ) Entering AuthPlayerLoginState`,
      `17:02:59.532  LOGINQUEUE   : Player 4242 updated with device type 'hologram'`,
      `17:03:00.010 [StateMachine]: Player Future1 (dpnid 4242 uid AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) Entering DBGetLoginTimeLoginState`,
    ].join("\n");
    expect(parseDevices(odd)).toEqual([]);
  });

  it("handles a gamertag containing spaces", () => {
    const spaced = [
      `17:02:57.100 [StateMachine]: Player Sir Alatorre (dpnid 77 uid ) Entering AuthPlayerLoginState`,
      `17:02:59.532  LOGINQUEUE   : Player 77 updated with device type 'desktop'`,
      `17:03:00.010 [StateMachine]: Player Sir Alatorre (dpnid 77 uid FA15BCA9C4CC97F352B03D710B0A6AC48907909E) Entering DBGetLoginTimeLoginState`,
    ].join("\n");
    expect(parseDevices(spaced)).toEqual([
      { dayzId: "FA15BCA9C4CC97F352B03D710B0A6AC48907909E", gamertag: "Sir Alatorre", device: "desktop" },
    ]);
  });

  /**
   * ⚠️ The gamertag is PLAYER-CONTROLLED, and in the raw line it comes
   * BEFORE the dpnid and uid the server wrote. That is why both regexes are
   * anchored to a whole line: without it, a gamertag containing the literal
   * text `(dpnid <n> uid <40 hex>)` binds the attacker's own StateMachine line
   * to a dpnid and uid they chose — so the attacker's `desktop` device line is
   * attributed to the victim, who is then banned for a platform they do not
   * play on, on a path with no dry-run net.
   */
  it("does not let a hostile gamertag bind a victim's uid to another dpnid", () => {
    const VICTIM = "B".repeat(40);
    const ATTACKER = "C".repeat(40);
    const hostile = [
      `17:02:57.100 [StateMachine]: Player Evil (dpnid 999 uid ${VICTIM}) (dpnid 4242 uid ) Entering AuthPlayerLoginState`,
      `17:02:59.532  LOGINQUEUE   : Player 4242 updated with device type 'desktop'`,
      `17:03:00.010 [StateMachine]: Player Evil (dpnid 999 uid ${VICTIM}) (dpnid 4242 uid ${ATTACKER}) Entering DBGetLoginTimeLoginState`,
    ].join("\n");
    const out = parseDevices(hostile);
    // The attacker's own uid is what the device line resolves to — never the
    // one they typed into their gamertag.
    expect(out).toEqual([
      { dayzId: ATTACKER, gamertag: `Evil (dpnid 999 uid ${VICTIM})`, device: "desktop" },
    ]);
    expect(out.some((s) => s.dayzId === VICTIM)).toBe(false);
  });

  it("returns nothing for an RPT with no login activity", () => {
    expect(parseDevices("17:02:15.199 SCRIPT : Module: GameLib; loaded 13x files")).toEqual([]);
  });
});
