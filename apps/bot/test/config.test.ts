import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const OK = {
  DISCORD_TOKEN: "t", DISCORD_APPLICATION_ID: "a", DISCORD_GUILD_ID: "g",
  DATABASE_URL: "postgres://x",
};

describe("loadConfig", () => {
  it("reads a complete environment", () => {
    const cfg = loadConfig(OK);
    expect(cfg).toMatchObject({ token: "t", applicationId: "a", guildId: "g", databaseUrl: "postgres://x" });
  });

  it("defaults the tick interval and challenge TTL", () => {
    const cfg = loadConfig(OK);
    expect(cfg.tickIntervalMs).toBe(10_000);
    expect(cfg.challengeTtlMs).toBe(600_000);
  });

  it.each(["DISCORD_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_GUILD_ID", "DATABASE_URL"])(
    "throws when %s is missing", (key) => {
      const env = { ...OK, [key]: undefined };
      expect(() => loadConfig(env)).toThrow(key);
    },
  );

  it("rejects a non-numeric tick interval instead of silently defaulting", () => {
    expect(() => loadConfig({ ...OK, BOT_TICK_INTERVAL_MS: "soon" })).toThrow(/BOT_TICK_INTERVAL_MS/);
  });

  it("rejects a zero or negative tick interval", () => {
    expect(() => loadConfig({ ...OK, BOT_TICK_INTERVAL_MS: "0" })).toThrow(/BOT_TICK_INTERVAL_MS/);
  });

  it("accepts an overridden challenge TTL", () => {
    expect(loadConfig({ ...OK, BOT_CHALLENGE_TTL_MS: "300000" }).challengeTtlMs).toBe(300_000);
  });
});
