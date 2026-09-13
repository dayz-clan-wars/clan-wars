import { describe, it, expect } from "vitest";
import { TABLES, VAULT_TABLES, LEADERSHIP_TABLES, DISCORD_OVERRIDES, discordCopy } from "../src/index";

const everyTable = { ...TABLES, ...VAULT_TABLES, ...LEADERSHIP_TABLES } as Record<string, Record<string, unknown>>;

/**
 * There is ONE table per action, shared by the site and the bot, so coverage
 * cannot diverge — only wording can, through DISCORD_OVERRIDES. These tests
 * guard the two ways that arrangement can still rot: an override that names an
 * outcome nobody returns any more, and an entry someone left blank.
 */
describe("copy tables", () => {
  it("has non-empty text for every outcome of every action", () => {
    for (const [action, table] of Object.entries(everyTable)) {
      for (const [outcome, text] of Object.entries(table)) {
        expect(typeof text, `${action}.${outcome}`).toBe("string");
        expect((text as string).trim(), `${action}.${outcome}`).not.toBe("");
      }
    }
  });

  it("says clan, never faction", () => {
    for (const [action, table] of Object.entries(everyTable)) {
      for (const [outcome, text] of Object.entries(table)) {
        expect((text as string).toLowerCase(), `${action}.${outcome}`).not.toContain("faction");
      }
    }
  });

  it("overrides only outcomes that exist", () => {
    for (const [action, table] of Object.entries(DISCORD_OVERRIDES as Record<string, Record<string, string>>)) {
      expect(everyTable[action], `unknown action ${action}`).toBeDefined();
      for (const outcome of Object.keys(table)) {
        expect(Object.hasOwn(everyTable[action]!, outcome), `${action}.${outcome} is not an outcome`).toBe(true);
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
