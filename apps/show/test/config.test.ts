import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_MODEL } from "../src/config.js";

const base = { DATABASE_URL: "postgres://db", OPENROUTER_API_KEY: "k" };

describe("loadConfig", () => {
  it("defaults the models and the staff tag", () => {
    expect(loadConfig(base)).toEqual({
      databaseUrl: "postgres://db", openrouterApiKey: "k",
      scriptModel: DEFAULT_MODEL, moderationModel: DEFAULT_MODEL, staffTags: ["ADM"],
    });
  });

  it("reads overrides and a comma list of staff tags", () => {
    const c = loadConfig({ ...base, SHOW_SCRIPT_MODEL: "a/b", SHOW_MODERATION_MODEL: "c/d", SHOW_STAFF_CLAN_TAGS: " ADM, MOD ,," });
    expect(c).toMatchObject({ scriptModel: "a/b", moderationModel: "c/d", staffTags: ["ADM", "MOD"] });
  });

  it.each(["DATABASE_URL", "OPENROUTER_API_KEY"])("requires %s", (key) => {
    const env: Record<string, string> = { ...base };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });
});
