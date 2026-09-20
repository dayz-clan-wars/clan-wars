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
    //
    // ⚠️ The ONE exception is `metadata.title`, by ruling: a <title> is chrome,
    // and every other page on the site uses "Clan Wars — <thing>". One page
    // diverging from that format is a more visible inconsistency than a dash
    // nobody reads as a dash. Stripped by line, so the exemption cannot widen.
    const withoutTitle = PAGE.split("\n").filter((l) => !l.trim().startsWith("title:")).join("\n");
    for (const [name, text] of [["page.tsx", withoutTitle], ["actions.ts", ACTIONS], ["kit-copy.ts", COPY]] as const) {
      expect([name, text.includes("—")]).toEqual([name, false]);
    }
  });

  it("keeps the site's title format", () => {
    expect(PAGE).toContain('title: "Clan Wars — your booster kit"');
  });

  /**
   * ⚠️ The emote count is LINK_EMOTES, a guide number in rules.ts. page.tsx
   * renders it from the sequence it was handed; this copy must not restate it.
   * A "three" typed here would go on saying three after the constant changed,
   * and nothing would fail: guide.test.ts scans guide chapters, not lib/.
   */
  it("states no emote count in copy, so LINK_EMOTES cannot drift out of it", () => {
    // Counted emotes specifically: "Pick one of the listed options" is prose,
    // "perform the three emotes" is a guide number restated by hand.
    const counted = /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+emotes?\b/iu;
    const offenders = Object.entries(RESULT_COPY).filter(([, c]) => counted.test(c));
    expect(offenders).toEqual([]);
    // And the page renders the count it was handed, never a literal.
    expect(PAGE).toContain("{view.challenge.steps.length} emotes");
  });

  /**
   * ⚠️ BOOSTER_TICK_INTERVAL_MS defaults to 15 minutes (apps/bot/src/config.ts)
   * and is an env var an operator can change. The page said "within a few
   * minutes", which was already false, and said "this page unlocks then",
   * which was never true: the page is never locked, only the pickers appear.
   * apps/web cannot import the bot's config, so the rule is that the sentence
   * carries no figure at all rather than one that can drift out of it.
   */
  it("promises no delay figure for the boost, and never says the page is locked", () => {
    expect(PAGE).not.toMatch(/within a few minutes|a few minutes of|\d+ minutes/u);
    expect(PAGE.toLowerCase()).not.toContain("unlock");
    expect(PAGE).toContain("the pickers appear on this page then");
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

describe("the kit page's carousel", () => {
  it("renders the picker as image tiles, not a select", async () => {
    const mod = await import("../app/(site)/kit/page");
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../app/(site)/kit/page.tsx", import.meta.url), "utf8"));
    expect(src).not.toContain("<select");
    expect(src).toContain("ItemCarousel");
    expect(mod).toBeDefined();
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

  /**
   * ⚠️ A refused pick is an answer for the player; a dead database is an
   * outage. A `catch` here would collapse the two and tell a booster their
   * valid jacket "is not on the list" while Postgres was down, so they would
   * re-pick from the same list forever and nobody would report the outage.
   * The refusal is an outcome from `@factions/roster`; nothing is caught.
   */
  it("reads the refusal as an outcome and catches nothing", () => {
    expect(ACTIONS).toContain("if (!out.ok) back(out.reason);");
    // Matched as syntax, not as a word: the comment above the action says
    // "try/catch" in prose, and banning the word would ban explaining the rule.
    expect(ACTIONS).not.toMatch(/catch\s*[({]/u);
    expect(ACTIONS).not.toMatch(/\btry\s*\{/u);
  });

  it("has copy for every refusal reason the roster write can return", () => {
    // The reasons are a union in packages/roster/src/booster-kit.ts; a new one
    // with no copy here would render a blank notice.
    for (const reason of ["bad-slot", "bad-pick"]) {
      expect([reason, Object.hasOwn(RESULT_COPY, reason)]).toEqual([reason, true]);
    }
  });
});
