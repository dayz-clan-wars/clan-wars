import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const OK = {
  DISCORD_TOKEN: "t", DISCORD_APPLICATION_ID: "a", DISCORD_GUILD_ID: "g",
  DATABASE_URL: "postgres://x",
};

const env = () => OK;

describe("loadConfig", () => {
  it("reads a complete environment", () => {
    const cfg = loadConfig(OK);
    expect(cfg).toMatchObject({ token: "t", applicationId: "a", guildId: "g", databaseUrl: "postgres://x" });
  });

  it("defaults the tick interval", () => {
    const cfg = loadConfig(OK);
    expect(cfg.tickIntervalMs).toBe(10_000);
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

  describe("BOT_FEED_CHANNEL_ID", () => {
    it("⚠️ is optional, so the feed is off unless deliberately turned on", () => {
      // Required would force every existing deployment and test fixture to
      // supply a channel id for a feature they do not use, and would let a
      // staging bot inherit a live community channel from a copied .env.
      expect(loadConfig({ ...OK }).feedChannelId).toBeUndefined();
    });

    it("reads the channel id when set", () => {
      expect(loadConfig({ ...OK, BOT_FEED_CHANNEL_ID: "1545142533603201184" }).feedChannelId)
        .toBe("1545142533603201184");
    });

    it("treats an empty string as unset rather than as a channel", () => {
      expect(loadConfig({ ...OK, BOT_FEED_CHANNEL_ID: "" }).feedChannelId).toBeUndefined();
    });

    it("rejects a non-snowflake, rather than failing at the first post", () => {
      expect(() => loadConfig({ ...OK, BOT_FEED_CHANNEL_ID: "#faction-feed" }))
        .toThrow(/BOT_FEED_CHANNEL_ID/u);
    });

    it("⚠️ rejects a leading-zero value, the README's old placeholder shape", () => {
      // "000000000000000000" is 18 digits and passed the old \d{17,20} regex
      // cleanly — a copy-pasted example loaded without error and then failed
      // every post. A real snowflake never starts with 0.
      expect(() => loadConfig({ ...OK, BOT_FEED_CHANNEL_ID: "000000000000000000" }))
        .toThrow(/BOT_FEED_CHANNEL_ID/u);
    });
  });

  describe("WAR_LOG_CHANNEL_ID", () => {
    it("⚠️ is optional, so the war log is off unless deliberately turned on", () => {
      expect(loadConfig({ ...OK }).warLogChannelId).toBeUndefined();
    });

    it("reads the channel id when set", () => {
      expect(loadConfig({ ...OK, WAR_LOG_CHANNEL_ID: "1545142533603201184" }).warLogChannelId)
        .toBe("1545142533603201184");
    });

    it("treats an empty string as unset rather than as a channel", () => {
      expect(loadConfig({ ...OK, WAR_LOG_CHANNEL_ID: "" }).warLogChannelId).toBeUndefined();
    });

    it("rejects a non-snowflake, rather than failing at the first post", () => {
      expect(() => loadConfig({ ...OK, WAR_LOG_CHANNEL_ID: "#war-log" }))
        .toThrow(/WAR_LOG_CHANNEL_ID/u);
    });

    it("⚠️ rejects a leading-zero value, the README's old placeholder shape", () => {
      expect(() => loadConfig({ ...OK, WAR_LOG_CHANNEL_ID: "000000000000000000" }))
        .toThrow(/WAR_LOG_CHANNEL_ID/u);
    });
  });

  describe("FLAG_IMAGE_BASE_URL", () => {
    it("⚠️ is optional, so embeds keep posting without thumbnails when unset", () => {
      // The feed shipped before any artwork existed and must keep working
      // exactly as it does today for anyone who never sets this.
      expect(loadConfig({ ...OK }).flagImageBaseUrl).toBeUndefined();
    });

    it("reads an https base URL", () => {
      expect(loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "https://dayzclanwars.com" }).flagImageBaseUrl)
        .toBe("https://dayzclanwars.com");
    });

    it("treats an empty string as unset", () => {
      expect(loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "" }).flagImageBaseUrl).toBeUndefined();
    });

    it("⚠️ rejects a malformed URL at load rather than at first post", () => {
      // An unset base is silent by design, so a broken one would otherwise be
      // indistinguishable from an unconfigured one until someone noticed the
      // embeds had no thumbnails.
      expect(() => loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "dayzclanwars.com" }))
        .toThrow(/FLAG_IMAGE_BASE_URL/u);
    });

    it("rejects a non-http scheme", () => {
      expect(() => loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "file:///etc/passwd" }))
        .toThrow(/FLAG_IMAGE_BASE_URL/u);
    });

    it("accepts a bare origin with a trailing slash", () => {
      // The resolver's own trailing-slash strip exists for exactly this
      // shape — tightening the validator must not break it.
      expect(loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "https://dayzclanwars.com/" }).flagImageBaseUrl)
        .toBe("https://dayzclanwars.com/");
    });

    it("⚠️ rejects a path, the reasonable-but-wrong value an operator would paste", () => {
      // The resolver appends /flags/<texture>.png itself. A base that already
      // includes /flags/ — the directory the operator was just looking at —
      // would silently resolve to nothing, with no error here or at post
      // time.
      expect(() => loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "https://dayzclanwars.com/flags/" }))
        .toThrow(/FLAG_IMAGE_BASE_URL/u);
    });

    it("rejects a query string", () => {
      expect(() => loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "https://dayzclanwars.com/foo?x=1" }))
        .toThrow(/FLAG_IMAGE_BASE_URL/u);
    });

    it("rejects a fragment", () => {
      expect(() => loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "https://dayzclanwars.com#frag" }))
        .toThrow(/FLAG_IMAGE_BASE_URL/u);
    });

    it("⚠️ rejects embedded credentials, which Discord's embed proxy would fetch", () => {
      expect(() => loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "https://user:pass@dayzclanwars.com" }))
        .toThrow(/FLAG_IMAGE_BASE_URL/u);
    });
  });

  describe("SITE_BASE_URL", () => {
    it("defaults to the production site", () => { expect(loadConfig(env()).siteBaseUrl).toBe("https://dayzclanwars.com"); });
    it("accepts a bare origin and rejects a path", () => {
      expect(loadConfig({ ...env(), SITE_BASE_URL: "http://localhost:3000" }).siteBaseUrl).toBe("http://localhost:3000");
      expect(() => loadConfig({ ...env(), SITE_BASE_URL: "https://x.y/clan" })).toThrow(/bare origin/u);
    });
    it("⚠️ strips a trailing slash, unlike FLAG_IMAGE_BASE_URL: every siteBaseUrl consumer concatenates its own path with no strip of its own, so an unstripped trailing slash would double up", () => {
      expect(loadConfig({ ...env(), SITE_BASE_URL: "https://dayzclanwars.com/" }).siteBaseUrl).toBe("https://dayzclanwars.com");
    });
  });
});
