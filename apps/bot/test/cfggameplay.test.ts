import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setBaseDamageDisabled } from "../src/cfggameplay.js";

const REAL = readFileSync(join(__dirname, "fixtures/cfggameplay.json"), "utf8");

describe("setBaseDamageDisabled", () => {
  it("opens the window by flipping true -> false", () => {
    const { json, changed } = setBaseDamageDisabled(REAL, false);
    expect(changed).toBe(true);
    expect(JSON.parse(json).GeneralData.disableBaseDamage).toBe(false);
  });

  it("⚠️ changes NOTHING else — every other byte is identical", () => {
    const { json } = setBaseDamageDisabled(REAL, false);
    // The only difference is the one literal. Normalising it back must restore
    // the input exactly: this catches reformatting, reordering and lost tabs.
    expect(json.replace('"disableBaseDamage": false', '"disableBaseDamage": true')).toBe(REAL);
  });

  it("⚠️ does not touch disableContainerDamage", () => {
    const { json } = setBaseDamageDisabled(REAL, false);
    expect(JSON.parse(json).GeneralData.disableContainerDamage).toBe(false);
  });

  it("reports changed=false and returns the input untouched when already correct", () => {
    const { json, changed } = setBaseDamageDisabled(REAL, true);
    expect(changed).toBe(false);
    expect(json).toBe(REAL);
  });

  it("round-trips: false then true returns the original bytes", () => {
    const opened = setBaseDamageDisabled(REAL, false).json;
    const closed = setBaseDamageDisabled(opened, true).json;
    expect(closed).toBe(REAL);
  });

  it("throws when the key is absent", () => {
    const without = JSON.stringify({ GeneralData: { disableContainerDamage: false } }, null, "\t");
    expect(() => setBaseDamageDisabled(without, false)).toThrow(/no "disableBaseDamage"/);
  });

  it("⚠️ throws when the key appears more than once rather than guessing", () => {
    // A second object carrying the same key name. A naive regex would rewrite
    // whichever came first and report success while GeneralData stayed put.
    const twice = REAL.replace(
      '"VehicleData": {',
      '"SomeModData": {\n\t\t"disableBaseDamage": true\n\t},\n\t"VehicleData": {',
    );
    expect(() => setBaseDamageDisabled(twice, false)).toThrow(/appears 2×/);
  });

  it("throws when the input does not parse", () => {
    expect(() => setBaseDamageDisabled('{"GeneralData": {"disableBaseDamage": true,}', false))
      .toThrow(/did not parse/);
  });

  it("⚠️ throws when the edit produced a file whose value is not what was asked for", () => {
    // Guard 2's own case: a file where the key we match is real but sits outside
    // GeneralData, so the edit parses fine and yet achieves nothing.
    const misplaced = '{\n\t"GeneralData": {\n\t\t"disableContainerDamage": false\n\t},\n\t"Other": {\n\t\t"disableBaseDamage": true\n\t}\n}';
    expect(() => setBaseDamageDisabled(misplaced, false)).toThrow(/GeneralData\.disableBaseDamage/);
  });
});
