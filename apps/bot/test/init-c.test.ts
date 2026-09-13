import { describe, it, expect } from "vitest";
import { renderInitC } from "../src/init-c.js";

/** A real 40-hex DayZ id, shaped after one read from the live script log. */
const UID_A = "75E109C86EABE1E14F7ACE47F2C9BF11757ACE0C";
const UID_B = "C87349CA0FCDDE3EAAE617E3E3349B013DD71F0A";

describe("renderInitC", () => {
  it("emits a lookup arm for each assignment", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    expect(c).toContain(`if (uid == "${UID_A}") return "Armband_Zenit";`);
  });

  /**
   * ⚠️ OnClientNewEvent, NOT StartingEquipSetup or EquipCharacter. With a spawn
   * preset configured (cfggameplay.json → spawnGearPresetFiles), vanilla
   * OnClientNewEvent returns immediately after ProcessEquipmentData and never
   * reaches either of the other two — a hook there is dead code that reports
   * success and equips nothing.
   */
  it("hooks OnClientNewEvent and equips only after super has run", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    expect(c).toContain("override PlayerBase OnClientNewEvent(PlayerIdentity identity, vector pos, ParamsReadContext ctx)");
    const superAt = c.indexOf("super.OnClientNewEvent(identity, pos, ctx)");
    const equipAt = c.indexOf("CreateAttachment(");
    expect(superAt).toBeGreaterThan(-1);
    expect(equipAt).toBeGreaterThan(superAt);
  });

  /**
   * ⚠️ The live init.c is CRLF, like the rest of the mission tree. Rendering LF
   * would differ from the server's copy on every single pass, so the tick's
   * upload-only-on-change check would re-upload forever and never settle.
   */
  it("renders CRLF, so an unchanged roster compares equal to the server's copy", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    expect(c).not.toMatch(/[^\r]\n/u);
    expect(c).toContain("\r\n");
  });

  /**
   * ⚠️ These two are the reason codegen is confined to string literals. Anything
   * that reaches the output becomes executable Enforce script, and a syntax error
   * in init.c stops the mission loading on a file the bot rewrites unattended
   * every couple of hours. A bad row is dropped, never emitted.
   */
  it("drops an id that is not 40 hex rather than emitting it", () => {
    const c = renderInitC([
      { dayzId: "not-a-real-id", armband: "Armband_Zenit" },
      { dayzId: UID_A, armband: "Armband_Zenit" },
    ]);
    expect(c).not.toContain("not-a-real-id");
    expect(c).toContain(UID_A);
  });

  it("drops an id carrying a quote, which would otherwise close the string literal", () => {
    const c = renderInitC([{ dayzId: `${UID_A}") return "x"; //`, armband: "Armband_Zenit" }]);
    expect(c).not.toContain(`return "x"`);
    expect(c).not.toContain(UID_A);
    expect(c).toContain(`return "";`);
  });

  it("drops an armband that is not an Armband_ classname", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Flag_Zenit" }]);
    expect(c).not.toContain("Flag_Zenit");
  });

  /**
   * Byte-stability across renders is what makes the tick's upload-only-on-change
   * check work: the roster query has no ORDER BY guarantee, and a reordered but
   * unchanged roster must not look like a change.
   */
  it("orders arms by id, so an unchanged roster renders byte-identically", () => {
    const a = { dayzId: UID_A, armband: "Armband_Zenit" };
    const b = { dayzId: UID_B, armband: "Armband_Red" };
    expect(renderInitC([a, b])).toBe(renderInitC([b, a]));
  });

  /**
   * ⚠️ Pure ASCII, unlike every other file in this repo. The server's original
   * init.c is ASCII, and this one is parsed by the Enforce compiler, not by
   * TypeScript — the house `⚠️`/em-dash comment style must not leak through the
   * template into a file whose parse failure stops the mission loading. Keep the
   * warnings in the TS around it, where they belong.
   */
  it("renders pure ASCII, since Enforce parses this file and not TypeScript", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    // eslint-disable-next-line no-control-regex
    const bad = [...c].filter((ch) => ch.charCodeAt(0) > 0x7f);
    expect(bad).toEqual([]);
  });

  it("keeps the mission scaffolding the server boots from", () => {
    const c = renderInitC([]);
    expect(c).toContain("void main()");
    expect(c).toContain("class CustomMission: MissionServer");
    expect(c).toContain("Mission CreateCustomMission(string path)");
  });
});
