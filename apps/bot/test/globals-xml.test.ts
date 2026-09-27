import { describe, it, expect } from "vitest";
import { setGlobalVar, readGlobalVar } from "../src/globals-xml.js";

/** Shaped after livonia/db/globals.xml (read 2026-09-27). */
const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<variables>
    <!-- keep this comment exactly where it is -->
    <var name="CleanupLifetimeDeadAnimal" type="0" value="1200"/>
    <var name="CleanupLifetimeDeadInfected" type="0" value="330"/>
    <var name="CleanupLifetimeDeadPlayer" type="0" value="3600"/>
    <var name="CleanupLifetimeDefault" type="0" value="45"/>
</variables>
`;

describe("readGlobalVar", () => {
  it("reads the named var's value", () => {
    expect(readGlobalVar(XML, "CleanupLifetimeDeadPlayer")).toBe(3600);
    expect(readGlobalVar(XML, "CleanupLifetimeDeadInfected")).toBe(330);
  });

  it("does not match a longer name that starts with the same text", () => {
    expect(readGlobalVar(XML, "CleanupLifetimeDead" + "Animal")).toBe(1200);
    expect(() => readGlobalVar(XML, "CleanupLifetimeDead")).toThrow(/no <var name="CleanupLifetimeDead">/);
  });

  it("ignores a commented-out copy of the var", () => {
    const xml = XML.replace("<variables>", `<variables>\n    <!-- <var name="CleanupLifetimeDeadPlayer" type="0" value="9"/> -->`);
    expect(readGlobalVar(xml, "CleanupLifetimeDeadPlayer")).toBe(3600);
  });

  it("refuses a var that appears twice outside comments", () => {
    const xml = XML.replace("</variables>", `    <var name="CleanupLifetimeDeadPlayer" type="0" value="9"/>\n</variables>`);
    expect(() => readGlobalVar(xml, "CleanupLifetimeDeadPlayer")).toThrow(/more than once/);
  });

  it("refuses a var with no numeric value", () => {
    const xml = XML.replace(`name="CleanupLifetimeDeadPlayer" type="0" value="3600"`, `name="CleanupLifetimeDeadPlayer" type="0"`);
    expect(() => readGlobalVar(xml, "CleanupLifetimeDeadPlayer")).toThrow(/no numeric value/);
  });
});

describe("setGlobalVar", () => {
  it("changes only the named var's value; everything else is byte-identical", () => {
    const r = setGlobalVar(XML, "CleanupLifetimeDeadPlayer", 30);
    expect(r.changed).toBe(true);
    expect(r.xml).toBe(XML.replace(`name="CleanupLifetimeDeadPlayer" type="0" value="3600"`, `name="CleanupLifetimeDeadPlayer" type="0" value="30"`));
  });

  it("reports no change when the var is already at the value", () => {
    const r = setGlobalVar(XML, "CleanupLifetimeDeadInfected", 330);
    expect(r).toEqual({ xml: XML, changed: false });
  });

  it("leaves a commented-out copy untouched", () => {
    const comment = `<!-- <var name="CleanupLifetimeDeadPlayer" type="0" value="9"/> -->`;
    const xml = XML.replace("<variables>", `<variables>\n    ${comment}`);
    const r = setGlobalVar(xml, "CleanupLifetimeDeadPlayer", 30);
    expect(r.xml).toContain(comment);
    expect(readGlobalVar(r.xml, "CleanupLifetimeDeadPlayer")).toBe(30);
  });

  it("throws, rather than adding one, when the var is missing", () => {
    expect(() => setGlobalVar(XML, "NoSuchVar", 1)).toThrow(/no <var name="NoSuchVar">/);
  });
});
