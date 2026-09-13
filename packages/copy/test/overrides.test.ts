import { describe, it, expect } from "vitest";
import {
  TABLES, VAULT_TABLES, LEADERSHIP_TABLES,
  DISCORD_OVERRIDES, DISCORD_VAULT_OVERRIDES, DISCORD_LEADERSHIP_OVERRIDES,
  discordCopy, discordVaultCopy, revealedCopy,
} from "../src/index";

/**
 * Three separate sets, not one merged object: `clan.ts`'s `input` and
 * `vault.ts`'s `input` are both real action names, and a `{ ...TABLES,
 * ...VAULT_TABLES }` spread would let one silently win, hiding the other
 * from every check below. Each set is named so failures say which table an
 * outcome belongs to.
 */
const SETS: { name: string; table: Record<string, Record<string, unknown>>; overrides: Record<string, Record<string, string>> }[] = [
  { name: "clan", table: TABLES, overrides: DISCORD_OVERRIDES as Record<string, Record<string, string>> },
  { name: "vault", table: VAULT_TABLES, overrides: DISCORD_VAULT_OVERRIDES as Record<string, Record<string, string>> },
  { name: "leadership", table: LEADERSHIP_TABLES, overrides: DISCORD_LEADERSHIP_OVERRIDES as Record<string, Record<string, string>> },
];

/**
 * There is ONE table per action, shared by the site and the bot, so coverage
 * cannot diverge — only wording can, through the three DISCORD_*_OVERRIDES
 * maps. These tests guard the ways that arrangement can still rot: an
 * override that names an outcome nobody returns any more, an entry someone
 * left blank, and an override that reintroduces "faction" even though the
 * shared table it patches does not.
 */
describe("copy tables", () => {
  it("has non-empty text for every outcome of every action", () => {
    for (const { name, table } of SETS) {
      for (const [action, outcomes] of Object.entries(table)) {
        for (const [outcome, text] of Object.entries(outcomes)) {
          expect(typeof text, `${name}.${action}.${outcome}`).toBe("string");
          expect((text as string).trim(), `${name}.${action}.${outcome}`).not.toBe("");
        }
      }
    }
  });

  it("says clan, never faction", () => {
    for (const { name, table } of SETS) {
      for (const [action, outcomes] of Object.entries(table)) {
        for (const [outcome, text] of Object.entries(outcomes)) {
          expect((text as string).toLowerCase(), `${name}.${action}.${outcome}`).not.toContain("faction");
        }
      }
    }
  });

  it("overrides only outcomes that exist, against their own table", () => {
    for (const { name, table, overrides } of SETS) {
      for (const [action, outcomes] of Object.entries(overrides)) {
        expect(table[action], `unknown ${name} action ${action}`).toBeDefined();
        for (const outcome of Object.keys(outcomes)) {
          expect(Object.hasOwn(table[action]!, outcome), `${name}.${action}.${outcome} is not an outcome`).toBe(true);
        }
      }
    }
  });

  it("override text says clan, never faction", () => {
    for (const { name, overrides } of SETS) {
      for (const [action, outcomes] of Object.entries(overrides)) {
        for (const [outcome, text] of Object.entries(outcomes)) {
          expect(text.toLowerCase(), `${name}.${action}.${outcome} override`).not.toContain("faction");
        }
      }
    }
  });

  it("falls through to the shared text when there is no override", () => {
    expect(discordCopy("recruiting", "ok")).toBe("Recruiting post saved.");
  });

  it("prefers the override when there is one", () => {
    expect(discordCopy("disband", "unconfirmed")).toBe("Press Confirm to disband — this cannot be undone.");
    expect(discordCopy("disband", "unconfirmed")).not.toBe(TABLES.disband.unconfirmed);
  });
});

describe("the vault's Discord wording", () => {
  it("asks for a button press, not a checkbox", () => {
    for (const action of ["delete", "rotate"] as const) {
      expect(discordVaultCopy(action, "unconfirmed")).toMatch(/Press Confirm/u);
      expect(discordVaultCopy(action, "unconfirmed")).not.toMatch(/tick|box/iu);
    }
  });

  /**
   * ⚠️ The revealed code is the one string in this package that carries a
   * secret. It exists here, rather than in apps/bot, for the same reason
   * every other sentence does — but it must stay a pure function of its two
   * arguments, with nothing logged and nothing cached.
   */
  it("names the lock beside the code, and says the code is not to be shared", () => {
    const line = revealedCopy("Front gate", "1234");
    expect(line).toContain("Front gate");
    expect(line).toContain("1234");
    expect(line).toMatch(/only you/iu);
  });
});
