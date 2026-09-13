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
  /**
   * ⚠️ super FIRST in every hook. The spawn preset equips inside super; calling
   * CW_GiveArmband before it would test an Armband slot that the preset has not
   * populated yet, and on the New path would pass a player that does not exist.
   */
  it.each([
    ["OnClientNewEvent", "super.OnClientNewEvent(identity, pos, ctx)"],
    ["OnClientRespawnEvent", "super.OnClientRespawnEvent(identity, player)"],
    ["OnClientReadyEvent", "super.OnClientReadyEvent(identity, player)"],
  ])("calls super before equipping in %s", (hook, superCall) => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    const body = c.slice(c.indexOf(`${hook}(PlayerIdentity`));
    const superAt = body.indexOf(superCall);
    const equipAt = body.indexOf("CW_GiveArmband(identity, player);");
    expect(superAt).toBeGreaterThan(-1);
    expect(equipAt).toBeGreaterThan(superAt);
  });

  it("hooks OnClientNewEvent, the event a first-join character creation fires", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    expect(c).toContain("override PlayerBase OnClientNewEvent(PlayerIdentity identity, vector pos, ParamsReadContext ctx)");
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

  /**
   * ⚠️ THE BUG THAT SHIPPED (2026-09-13, reverted). Hooking OnClientNewEvent
   * alone equips nobody on a respawn: DayZ calls OnClientNewEvent when a
   * character is created ON CONNECT, and OnClientRespawnEvent when a player
   * makes a new character AFTER DEATH. A suicide at 21:20:07 produced a fresh
   * character at 21:20:27 with no armband and no error — the hook simply never
   * ran. Both events must reach the same equip path.
   */
  it("hooks OnClientRespawnEvent, the event a death-respawn actually fires", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    expect(c).toContain("override void OnClientRespawnEvent(PlayerIdentity identity, PlayerBase player)");
  });

  /**
   * ⚠️ OnStoreLoad is a PlayerBase method, so hooking it would need
   * `modded class PlayerBase` — a mod, which console DayZ does not allow.
   * OnClientReadyEvent is MissionServer's equivalent moment (an existing saved
   * character loaded on connect) and IS overridable from init.c.
   */
  it("hooks OnClientReadyEvent, so a reconnect with an existing character is covered", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    expect(c).toContain("override void OnClientReadyEvent(PlayerIdentity identity, PlayerBase player)");
  });

  it("routes all three spawn events through one equip path", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    // exactly one place creates the attachment, called from all three hooks
    expect(c.match(/CreateAttachment\(/gu)).toHaveLength(1);
    expect(c.match(/CW_GiveArmband\(identity, player\);/gu)).toHaveLength(3);
  });

  /**
   * ⚠️ Fill an EMPTY slot only. A player wearing a captured enemy band has made
   * a choice; overwriting it would turn a spawn gift into enforcement, which is
   * explicitly not what this is (and would kill armband deception outright).
   */
  it("only fills an empty Armband slot", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    expect(c).toContain('FindAttachmentBySlotName("Armband")');
  });

  /**
   * ⚠️ Deployed twice with no logging, and both times the failure was silent —
   * the script log could not say whether the hook fired, what id it saw, or
   * whether the attach succeeded. Every branch of the equip path prints.
   */
  it("prints the id, the band and the attach result, so a silent failure is impossible", () => {
    const c = renderInitC([{ dayzId: UID_A, armband: "Armband_Zenit" }]);
    expect(c).toContain('Print("[CLANWARS]');
    const prints = c.match(/Print\("\[CLANWARS\]/gu) ?? [];
    expect(prints.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * ⚠️ PLATFORM PROBES. On 2026-09-13 all three spawn hooks ran silent on a
   * clean compile, which cannot distinguish "the override was not invoked" from
   * "init.c never executed" from "Print is stripped on console RELEASE builds".
   * These two probes sit on code paths whose execution is not in question —
   * main() calls CreateHive(), and CreateCustomMission() is the mission factory
   * the engine asks for — so their presence or absence in the script log
   * partitions the failure exactly.
   */
  it.each([
    ["main", "[CLANWARS] main() running"],
    ["CreateCustomMission", "[CLANWARS] CreateCustomMission() called"],
  ])("prints a platform probe from %s", (_where, line) => {
    const c = renderInitC([]);
    expect(c).toContain(`Print("${line}");`);
  });

  it("keeps the mission scaffolding the server boots from", () => {
    const c = renderInitC([]);
    expect(c).toContain("void main()");
    expect(c).toContain("class CustomMission: MissionServer");
    expect(c).toContain("Mission CreateCustomMission(string path)");
  });
});
