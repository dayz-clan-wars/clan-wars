import { describe, it, expect } from "vitest";
import { at, rel, atRel } from "../src/index";

/**
 * ⚠️ The invalid-date cases are the reason this module exists. Before it,
 * only feed-embed.ts guarded against NaN; the other five call sites would
 * have posted a literal `<t:NaN:R>` into a public channel permanently,
 * because nothing reposts. `null` rather than a fallback string is
 * deliberate: each caller already has a degrade it chose.
 */
describe("discord-time", () => {
  const d = new Date("2026-09-21T14:30:00.000Z"); // 1790001000

  it("renders the full style", () => {
    expect(at(d)).toBe("<t:1790001000:F>");
  });

  it("renders the relative style", () => {
    expect(rel(d)).toBe("<t:1790001000:R>");
  });

  it("renders both, full first", () => {
    expect(atRel(d)).toBe("<t:1790001000:F> (<t:1790001000:R>)");
  });

  it("floors to whole seconds rather than rounding", () => {
    expect(at(new Date("2026-09-21T14:30:00.999Z"))).toBe("<t:1790001000:F>");
  });

  it("handles instants before the epoch", () => {
    expect(rel(new Date("1969-12-31T23:59:59.000Z"))).toBe("<t:-1:R>");
  });

  it.each([
    ["at", at],
    ["rel", rel],
    ["atRel", atRel],
  ])("%s returns null for an invalid date", (_name, fn) => {
    expect(fn(new Date("not a date"))).toBeNull();
  });
});
