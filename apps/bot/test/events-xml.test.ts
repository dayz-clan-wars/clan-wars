import { describe, it, expect } from "vitest";
import { setEventActive } from "../src/events-xml.js";

/** Shaped after the live clan-wars <mission>/db/events.xml (read 2026-09-12). */
const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<events>
    <!-- keep this comment exactly where it is -->
    <event name="VehicleSedan02">
        <nominal>10</nominal>
        <active>1</active>
    </event>
    <event name="VehicleTruck01">
        <nominal>20</nominal>
        <lifetime>300</lifetime>
        <flags deletable="0" init_random="0" remove_damaged="1" />
        <position>fixed</position>
        <limit>mixed</limit>
        <active>1</active>
        <children>
            <child lootmax="0" lootmin="0" max="10" min="3" type="Truck_01_Covered" />
        </children>
    </event>
</events>
`;

describe("setEventActive", () => {
  it("sets the named event's active flag to 0", () => {
    const r = setEventActive(XML, "VehicleTruck01", 0);
    expect(r.changed).toBe(true);
    expect(/<event name="VehicleTruck01">[\s\S]*?<\/event>/.exec(r.xml)![0])
      .toContain("<active>0</active>");
  });

  it("leaves sibling events untouched", () => {
    const r = setEventActive(XML, "VehicleTruck01", 0);
    expect(/<event name="VehicleSedan02">[\s\S]*?<\/event>/.exec(r.xml)![0])
      .toContain("<active>1</active>");
  });

  it("reports changed=false and returns the xml byte-identical when already at the target", () => {
    const r = setEventActive(XML, "VehicleTruck01", 1);
    expect(r.changed).toBe(false);
    expect(r.xml).toBe(XML);
  });

  it("preserves comments, the declaration and the exact byte length", () => {
    const r = setEventActive(XML, "VehicleTruck01", 0);
    expect(r.xml).toContain("<!-- keep this comment exactly where it is -->");
    expect(r.xml).toContain(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`);
    expect(r.xml.length).toBe(XML.length);
  });

  it("throws when the event is absent", () => {
    expect(() => setEventActive(XML, "VehicleNotHere", 0)).toThrow(/VehicleNotHere/);
  });

  it("throws when the event block carries no <active> element", () => {
    const xml = `<events><event name="VehicleTruck01"><nominal>5</nominal></event></events>`;
    expect(() => setEventActive(xml, "VehicleTruck01", 0)).toThrow(/active/i);
  });

  // ⚠️ Commenting an event out is THE standard way an admin disables one by hand, so a
  // stale commented block above the live one is the likeliest real input. Matching it
  // would rewrite the comment, report changed=true, upload, and never wipe anything.
  it("ignores a commented-out block and edits the live one below it", () => {
    const xml = `<events>
  <!--
  <event name="VehicleTruck01">
    <active>1</active>
  </event>
  -->
  <event name="VehicleTruck01">
    <active>1</active>
  </event>
</events>`;
    const r = setEventActive(xml, "VehicleTruck01", 0);
    expect(r.changed).toBe(true);
    const [commented, live] = r.xml.split("-->");
    expect(commented).toContain("<active>1</active>"); // comment untouched
    expect(live).toContain("<active>0</active>"); // live block wiped
  });

  it("ignores an <active> commented out inside the event body", () => {
    const xml = `<events><event name="VehicleTruck01"><!-- <active>1</active> --><active>1</active></event></events>`;
    const r = setEventActive(xml, "VehicleTruck01", 0);
    expect(r.xml).toContain("<!-- <active>1</active> -->");
    expect(r.xml).toContain("--><active>0</active>");
  });

  it("matches an event tag that carries extra attributes", () => {
    const xml = `<events><event name="VehicleTruck01" usable="true"><active>1</active></event></events>`;
    expect(setEventActive(xml, "VehicleTruck01", 0).xml).toContain("<active>0</active>");
  });

  it("does not mistake a longer name for the target", () => {
    const xml = `<events><event name="VehicleTruck01Covered"><active>1</active></event><event name="VehicleTruck01"><active>1</active></event></events>`;
    const r = setEventActive(xml, "VehicleTruck01", 0);
    expect(r.xml).toContain(`<event name="VehicleTruck01Covered"><active>1</active>`);
    expect(r.xml).toContain(`<event name="VehicleTruck01"><active>0</active>`);
  });

  // ⚠️ Silently editing only the first of two live blocks would leave the second
  // spawning trucks while the log claims the wipe succeeded.
  it("throws when the same event name appears twice outside comments", () => {
    const xml = `<events><event name="VehicleTruck01"><active>1</active></event><event name="VehicleTruck01"><active>1</active></event></events>`;
    expect(() => setEventActive(xml, "VehicleTruck01", 0)).toThrow(/twice|duplicate|more than once/i);
  });
});
