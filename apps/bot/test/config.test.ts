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
    expect(cfg.challengeTtlMs).toBe(86_400_000);
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

  it("throws when a required value is set to the empty string", () => {
    // ProcessEnv values are string | undefined, and every required value here
    // is meaningless when empty, so "" must be treated as absent.
    expect(() => loadConfig({ ...OK, DISCORD_TOKEN: "" })).toThrow(/DISCORD_TOKEN/);
  });

  it.each(["0x10", "1e3", " 10 ", "9007199254740993"])(
    "rejects %s rather than silently reinterpreting it", (raw) => {
      // Number("0x10") is 16 — a typo'd interval would tick 60x/sec while
      // appearing configured. Number("1e3") and Number(" 10 ") also succeed,
      // and values past MAX_SAFE_INTEGER round silently.
      expect(() => loadConfig({ ...OK, BOT_TICK_INTERVAL_MS: raw })).toThrow(/BOT_TICK_INTERVAL_MS/);
    },
  );

  it("accepts an overridden challenge TTL", () => {
    expect(loadConfig({ ...OK, BOT_CHALLENGE_TTL_MS: "300000" }).challengeTtlMs).toBe(300_000);
  });

  it("defaults the reservation window to 24 hours", () => {
    expect(loadConfig(OK).reservationTtlMs).toBe(86_400_000);
  });

  it("defaults the roster durations", () => {
    const cfg = loadConfig(OK);
    expect(cfg.inviteTtlMs).toBe(604_800_000);
    expect(cfg.cooldownMs).toBe(259_200_000);
    expect(cfg.renameCooldownMs).toBe(604_800_000);
  });

  it("accepts overridden roster durations", () => {
    const cfg = loadConfig({
      ...OK,
      BOT_INVITE_TTL_MS: "1000",
      BOT_COOLDOWN_MS: "2000",
      BOT_RENAME_COOLDOWN_MS: "3000",
    });
    expect(cfg.inviteTtlMs).toBe(1000);
    expect(cfg.cooldownMs).toBe(2000);
    expect(cfg.renameCooldownMs).toBe(3000);
  });

  it("defaults the dormancy windows to 7 and 14 days", () => {
    const cfg = loadConfig(OK);
    expect(cfg.dormantAfterMs).toBe(604_800_000);
    expect(cfg.disbandAfterDormantMs).toBe(1_209_600_000);
  });

  it("rejects a dormancy window Number() would silently reinterpret", () => {
    for (const raw of ["7e3", " 10 ", "0x10", "soon", "0", "-5"]) {
      expect(() => loadConfig({ ...OK, BOT_DORMANT_AFTER_MS: raw })).toThrow(/BOT_DORMANT_AFTER_MS/);
      expect(() => loadConfig({ ...OK, BOT_DISBAND_AFTER_DORMANT_MS: raw })).toThrow(/BOT_DISBAND_AFTER_DORMANT_MS/);
    }
  });
});
