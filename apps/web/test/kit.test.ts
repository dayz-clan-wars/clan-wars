import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_SLOTS } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { GROUND_RULES, RESULT_COPY, SLOT_LABELS } from "../lib/kit-copy";

/**
 * The booster kit page. Its writes are tested where the database is
 * (`packages/roster/test/booster-kit.test.ts`) — `apps/web` imports no
 * database package and has no test database of its own (test/smoke.test.ts).
 * What is pinned here is what this app owns: the copy, and the three states
 * the page must render.
 */
const PAGE = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "kit", "page.tsx"), "utf8");
const ACTIONS = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "kit", "actions.ts"), "utf8");
const COPY = readFileSync(join(import.meta.dirname, "..", "lib", "kit-copy.ts"), "utf8");

/** Every string a player reads on this page, in one list. */
const PLAYER_COPY = [...Object.values(RESULT_COPY), ...GROUND_RULES, ...Object.values(SLOT_LABELS)];

describe("the kit page's copy", () => {
  it("names all nine slots, and nothing else", () => {
    expect(Object.keys(SLOT_LABELS).sort()).toEqual([...KIT_SLOTS].sort());
  });

  it("uses no em dash anywhere in the page, its actions, or its copy", () => {
    // ⚠️ The house comment style uses em dashes freely; this page does not,
    // in copy OR in comments, because the two are one keystroke apart in a
    // JSX file and a dash that leaks into copy is invisible in review.
    for (const [name, text] of [["page.tsx", PAGE], ["actions.ts", ACTIONS], ["kit-copy.ts", COPY]] as const) {
      expect([name, text.includes("—")]).toEqual([name, false]);
    }
  });

  it("says plainly that the kit is on the ground, takeable, and back at the restart", () => {
    const all = GROUND_RULES.join(" ").toLowerCase();
    expect(all).toContain("on the ground");
    expect(all).toContain("anyone who finds it can take it");
    expect(all).toContain("next restart");
  });

  it("never frames the kit as protected, and never talks a player out of raiding", () => {
    // The guide's standing rule: nothing on the site may discourage a raid.
    const banned = ["protected", "safe from", "exclusive", "nobody else can", "do not raid", "don't raid", "off limits"];
    for (const phrase of banned) {
      expect([phrase, PLAYER_COPY.some((c) => c.toLowerCase().includes(phrase))]).toEqual([phrase, false]);
    }
  });

  it("has a result code for every outcome the actions can redirect with", () => {
    const codes = [...ACTIONS.matchAll(/back\("([a-z-]+)"\)/gu)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect([code, Object.hasOwn(RESULT_COPY, code)]).toEqual([code, true]);
  });
});

describe("the kit page's three states", () => {
  it("renders the perk for a visitor who is not boosting, rather than gating the page", () => {
    // ⚠️ Someone deciding whether to boost has to be able to see what they
    // would get. An early return on `!view.boosting` would hide exactly that.
    expect(PAGE).toContain("{!view.boosting && (");
    expect(PAGE).not.toMatch(/if\s*\(\s*!view\.boosting\s*\)\s*return/u);
  });

  it("points a boosting visitor with no link at the link flow", () => {
    expect(PAGE).toContain("{view.boosting && !view.linked && (");
    expect(PAGE).toContain('href="/link"');
  });

  it("gives a boosting, linked visitor the nine pickers, the armband and the placement button", () => {
    expect(PAGE).toContain("{view.boosting && view.linked && (");
    expect(PAGE).toContain("KIT_SLOTS.map((slot) => <SlotPicker");
    expect(PAGE).toContain("view.armband");
    expect(PAGE).toContain("action={startPlacement}");
  });

  it("shows the armband read-only: no form, no select, no name it could be saved under", () => {
    // ⚠️ The armband is derived from the clan's flag, so a control for it
    // would offer a pick the write layer has no column to store.
    expect(KIT_SLOTS).not.toContain("armband");
    expect(PAGE).not.toMatch(/name="armband"/u);
  });

  it("offers only catalogue options for each slot", () => {
    const catalogue = boosterCatalogue();
    for (const slot of KIT_SLOTS) expect([slot, catalogue[slot].length > 0]).toEqual([slot, true]);
    expect(PAGE).toContain("boosterCatalogue()[slot]");
  });
});

describe("the kit actions", () => {
  it("re-checks the session and the booster state inside the action, not just at render", () => {
    // ⚠️ A server action is a POST endpoint anyone can call. Rendering the
    // form only for a booster is not a check.
    expect(ACTIONS).toContain('"use server"');
    expect(ACTIONS).toContain("currentSession()");
    expect(ACTIONS).toContain("view.boosting");
  });

  it("never writes a position: saving gear calls the slot write alone", () => {
    expect(ACTIONS).toContain("saveBoosterKitSlot(discordId, slot, className)");
    expect(ACTIONS).not.toMatch(/pos[XYZ]/u);
  });
});
