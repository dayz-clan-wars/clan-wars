import { describe, it, expect } from "vitest";
import { loadConfig, MAX_TIMER_MS } from "../src/config.js";

const OK = {
  DISCORD_TOKEN: "t", DISCORD_APPLICATION_ID: "a", DISCORD_GUILD_ID: "g",
  DATABASE_URL: "postgres://x",
  CLAN_TEXT_CATEGORY_ID: "12345678901234567", CLAN_VOICE_CATEGORY_ID: "22345678901234567", LINKED_ROLE_ID: "32345678901234567",
  ALPHA_ROLE_ID: "42345678901234567",
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

  /**
   * ⚠️ A larger number is not a longer interval. Node stores a timer delay in a
   * signed 32-bit int: past MAX_TIMER_MS `setInterval` warns and uses 1 ms, so
   * an extra-digits typo turns the tick loop into a database hammer while the
   * value in `.env` reads like a longer interval than intended. Refused rather
   * than clamped — clamping would run an interval the config does not say.
   */
  it("rejects a tick interval past what setInterval honours", () => {
    expect(() => loadConfig({ ...OK, BOT_TICK_INTERVAL_MS: String(MAX_TIMER_MS + 1) }))
      .toThrow(/BOT_TICK_INTERVAL_MS must be at most 2147483647/);
    // The message has to say why, or the next person raises the cap.
    expect(() => loadConfig({ ...OK, BOT_TICK_INTERVAL_MS: "100000000000" }))
      .toThrow(/fires every 1 ms/);
  });

  it("accepts the largest interval setInterval does honour", () => {
    expect(loadConfig({ ...OK, BOT_TICK_INTERVAL_MS: String(MAX_TIMER_MS) }).tickIntervalMs).toBe(MAX_TIMER_MS);
  });

  /**
   * The cap belongs to this one key. The dormancy windows are durations
   * compared arithmetically, never `setInterval` delays — 14 days is 1.2e9 ms
   * and fits, but a longer window is a legitimate setting, not a typo.
   */
  it("does not cap the dormancy windows", () => {
    const cfg = loadConfig({ ...OK, BOT_DORMANT_AFTER_MS: String(MAX_TIMER_MS + 1) });
    expect(cfg.dormantAfterMs).toBe(MAX_TIMER_MS + 1);
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

  describe("PLAYERS_ONLINE_CHANNEL_ID", () => {
    it("is optional, reads a snowflake, and rejects anything else", () => {
      expect(loadConfig({ ...OK }).playersOnlineChannelId).toBeUndefined();
      expect(loadConfig({ ...OK, PLAYERS_ONLINE_CHANNEL_ID: "1546928156902949016" }).playersOnlineChannelId).toBe("1546928156902949016");
      expect(() => loadConfig({ ...OK, PLAYERS_ONLINE_CHANNEL_ID: "#players-online" })).toThrow(/PLAYERS_ONLINE_CHANNEL_ID/u);
    });
  });

  describe("KILL_FEED_CHANNEL_ID", () => {
    it("⚠️ is optional, so the kill feed is off unless deliberately turned on", () => {
      expect(loadConfig({ ...OK }).killFeedChannelId).toBeUndefined();
    });

    it("reads the channel id when set, and rejects a non-snowflake", () => {
      expect(loadConfig({ ...OK, KILL_FEED_CHANNEL_ID: "1546919850583261215" }).killFeedChannelId).toBe("1546919850583261215");
      expect(() => loadConfig({ ...OK, KILL_FEED_CHANNEL_ID: "#kill-feed" })).toThrow(/KILL_FEED_CHANNEL_ID/u);
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

  describe("ACHIEVEMENTS_CHANNEL_ID / ACHIEVEMENTS_TICK", () => {
    it("ACHIEVEMENTS_CHANNEL_ID is optional and ACHIEVEMENTS_TICK defaults off", () => {
      const cfg = loadConfig(OK);
      expect(cfg.achievementsChannelId).toBeUndefined();
      expect(cfg.achievementsTick).toBe(false);
      expect(loadConfig({ ...OK, ACHIEVEMENTS_CHANNEL_ID: "123456789012345678", ACHIEVEMENTS_TICK: "1" }))
        .toMatchObject({ achievementsChannelId: "123456789012345678", achievementsTick: true });
      expect(() => loadConfig({ ...OK, ACHIEVEMENTS_CHANNEL_ID: "nope" })).toThrow(/ACHIEVEMENTS_CHANNEL_ID/u);
    });
  });

  describe("RESTART_SCHEDULE / NITRADO_TOKEN", () => {
    it("defaults off, token optional while off", () => {
      const cfg = loadConfig(OK);
      expect(cfg.restartSchedule).toBe(false);
      expect(cfg.nitradoToken).toBeUndefined();
    });
    it("on with a token loads", () => {
      expect(loadConfig({ ...OK, RESTART_SCHEDULE: "1", NITRADO_TOKEN: "nt" })).toMatchObject({ restartSchedule: true, nitradoToken: "nt" });
      expect(loadConfig({ ...OK, RESTART_SCHEDULE: "true", NITRADO_TOKEN: "nt" }).restartSchedule).toBe(true);
    });
    it("⚠️ on without a token refuses to load — a schedule that cannot authenticate must not look like one that works", () => {
      expect(() => loadConfig({ ...OK, RESTART_SCHEDULE: "1" })).toThrow(/NITRADO_TOKEN/u);
      expect(() => loadConfig({ ...OK, RESTART_SCHEDULE: "1", NITRADO_TOKEN: "  " })).toThrow(/NITRADO_TOKEN/u);
    });
  });

  describe("TRUCK_WIPE", () => {
    const ON = { ...OK, RESTART_SCHEDULE: "1", NITRADO_TOKEN: "nt" };

    it("is off when TRUCK_WIPE_EVENTS is unset", () => {
      expect(loadConfig({ ...ON }).truckWipe.events).toEqual([]);
    });

    it("parses a comma-separated list, trimming and dropping blanks", () => {
      expect(loadConfig({ ...ON, TRUCK_WIPE_EVENTS: " VehicleTruck01 ,, VehicleSedan02 " }).truckWipe.events)
        .toEqual(["VehicleTruck01", "VehicleSedan02"]);
    });

    it("defaults the window to 08:00-10:00 UTC", () => {
      const c = loadConfig({ ...ON, TRUCK_WIPE_EVENTS: "VehicleTruck01" });
      expect(c.truckWipe).toMatchObject({ offHour: 8, onHour: 10 });
    });

    it("accepts an overridden window", () => {
      const c = loadConfig({ ...ON, TRUCK_WIPE_EVENTS: "VehicleTruck01", TRUCK_WIPE_OFF_HOUR: "6", TRUCK_WIPE_ON_HOUR: "14" });
      expect(c.truckWipe).toMatchObject({ offHour: 6, onHour: 14 });
    });

    // ⚠️ The repo rule is "never a silent default". An operator who blanks the line
    // to turn it off must not silently get a midnight wipe.
    it("refuses a blank hour rather than coercing it to 0", () => {
      expect(() => loadConfig({ ...ON, TRUCK_WIPE_EVENTS: "VehicleTruck01", TRUCK_WIPE_OFF_HOUR: "" })).toThrow(/TRUCK_WIPE_OFF_HOUR/u);
    });

    it("refuses an hour outside 0-23 and a non-numeric one", () => {
      expect(() => loadConfig({ ...ON, TRUCK_WIPE_EVENTS: "VehicleTruck01", TRUCK_WIPE_ON_HOUR: "24" })).toThrow(/TRUCK_WIPE_ON_HOUR/u);
      expect(() => loadConfig({ ...ON, TRUCK_WIPE_EVENTS: "VehicleTruck01", TRUCK_WIPE_ON_HOUR: "noon" })).toThrow(/TRUCK_WIPE_ON_HOUR/u);
    });

    // ⚠️ Restarts land on even UTC hours only. An odd hour would never be a slot, so
    // the window boundary would never be the state any server actually boots into.
    it("refuses an odd hour, which is never a restart slot", () => {
      expect(() => loadConfig({ ...ON, TRUCK_WIPE_EVENTS: "VehicleTruck01", TRUCK_WIPE_OFF_HOUR: "7" })).toThrow(/slot|even/iu);
    });

    it("refuses an empty window", () => {
      expect(() => loadConfig({ ...ON, TRUCK_WIPE_EVENTS: "VehicleTruck01", TRUCK_WIPE_OFF_HOUR: "8", TRUCK_WIPE_ON_HOUR: "8" })).toThrow(/window/iu);
    });

    // ⚠️ The wipe rides on the restart tick. Configured without it, nothing would
    // ever fire and the trucks would simply never wipe, with no error anywhere.
    it("refuses events without RESTART_SCHEDULE, which is what would fire them", () => {
      expect(() => loadConfig({ ...OK, TRUCK_WIPE_EVENTS: "VehicleTruck01" })).toThrow(/RESTART_SCHEDULE/u);
    });

    it("leaves the rotation off by default", () => {
      expect(loadConfig({ ...ON }).truckWipe.rotation).toBe(false);
    });

    it("turns the rotation on with WEEKLY_VEHICLE_WIPE", () => {
      expect(loadConfig({ ...ON, WEEKLY_VEHICLE_WIPE: "1" }).truckWipe.rotation).toBe(true);
      expect(loadConfig({ ...ON, WEEKLY_VEHICLE_WIPE: "true" }).truckWipe.rotation).toBe(true);
    });

    // ⚠️ The rotation rides on the restart slots. Configured without them nothing would
    // ever fire it — no error, no log, just a wipe that never happens.
    it("refuses the rotation without RESTART_SCHEDULE", () => {
      expect(() => loadConfig({ ...OK, WEEKLY_VEHICLE_WIPE: "1" })).toThrow(/RESTART_SCHEDULE/u);
    });

    // ⚠️ Independently switchable: the daily truck wipe and the weekly rotation must
    // each be able to run with the other off.
    it("runs the rotation with no daily truck events", () => {
      const c = loadConfig({ ...ON, WEEKLY_VEHICLE_WIPE: "1" });
      expect(c.truckWipe.events).toEqual([]);
      expect(c.truckWipe.rotation).toBe(true);
    });

    it("reads the announcements channel, and leaves it undefined when unset", () => {
      expect(loadConfig({ ...ON }).announcementsChannelId).toBeUndefined();
      expect(loadConfig({ ...ON, ANNOUNCEMENTS_CHANNEL_ID: "123456789012345678" })
        .announcementsChannelId).toBe("123456789012345678");
    });

    it("rejects a malformed announcements channel id", () => {
      expect(() => loadConfig({ ...ON, ANNOUNCEMENTS_CHANNEL_ID: "not-an-id" }))
        .toThrow(/ANNOUNCEMENTS_CHANNEL_ID/u);
    });

    // ⚠️ If an operator puts a rotation vehicle in TRUCK_WIPE_EVENTS too, the rotation
    // loop overwrites the daily 0 with 1 on every non-Monday slot, silently defeating
    // the daily wipe for that event. The rotation already owns these events.
    describe("overlap between TRUCK_WIPE_EVENTS and the rotation", () => {
      it("refuses an event that is in both lists when the rotation is on", () => {
        expect(() => loadConfig({
          ...ON, WEEKLY_VEHICLE_WIPE: "1", TRUCK_WIPE_EVENTS: "VehicleCivilianSedan",
        })).toThrow(/VehicleCivilianSedan/u);
      });

      it("names every offending event", () => {
        expect(() => loadConfig({
          ...ON, WEEKLY_VEHICLE_WIPE: "1",
          TRUCK_WIPE_EVENTS: "VehicleCivilianSedan,VehicleHatchback02,VehicleTruck01",
        })).toThrow(/VehicleCivilianSedan.*VehicleHatchback02|VehicleHatchback02.*VehicleCivilianSedan/su);
      });

      it("allows the same event in TRUCK_WIPE_EVENTS when the rotation is off", () => {
        expect(loadConfig({ ...ON, TRUCK_WIPE_EVENTS: "VehicleCivilianSedan" }).truckWipe.events)
          .toEqual(["VehicleCivilianSedan"]);
      });

      it("allows disjoint lists", () => {
        const c = loadConfig({ ...ON, WEEKLY_VEHICLE_WIPE: "1", TRUCK_WIPE_EVENTS: "VehicleTruck01" });
        expect(c.truckWipe.events).toEqual(["VehicleTruck01"]);
        expect(c.truckWipe.rotation).toBe(true);
      });
    });
  });

  describe("RAID_WINDOW_TICK", () => {
    it("is off by default", () => {
      expect(loadConfig(OK).raidWindow.enabled).toBe(false);
    });

    it("⚠️ refuses RAID_WINDOW_TICK without RESTART_SCHEDULE", () => {
      // Same failure shape as TRUCK_WIPE_EVENTS above: the flip only takes
      // effect at a restart, so it must ride on RESTART_SCHEDULE.
      expect(() => loadConfig({ ...OK, RAID_WINDOW_TICK: "1" })).toThrow(/RESTART_SCHEDULE/u);
    });

    it("accepts RAID_WINDOW_TICK with RESTART_SCHEDULE on", () => {
      const c = loadConfig({
        ...OK, RAID_WINDOW_TICK: "1", RESTART_SCHEDULE: "1", NITRADO_TOKEN: "nt",
        ANNOUNCEMENTS_CHANNEL_ID: "12345678901234567",
      });
      expect(c.raidWindow.enabled).toBe(true);
    });

    it("accepts the 'true' spelling, matching every other boolean flag", () => {
      const c = loadConfig({
        ...OK, RAID_WINDOW_TICK: "true", RESTART_SCHEDULE: "1", NITRADO_TOKEN: "nt",
        ANNOUNCEMENTS_CHANNEL_ID: "12345678901234567",
      });
      expect(c.raidWindow.enabled).toBe(true);
    });

    it("⚠️ refuses RAID_WINDOW_TICK without ANNOUNCEMENTS_CHANNEL_ID", () => {
      // The advance/open/close notices are the player-facing point of this
      // feature; with no channel to post them to it is misconfigured, not
      // merely degraded — unlike OPS_CHANNEL_ID, which has a real fallback
      // (an error-level log line).
      expect(() => loadConfig({ ...OK, RAID_WINDOW_TICK: "1", RESTART_SCHEDULE: "1", NITRADO_TOKEN: "nt" }))
        .toThrow(/ANNOUNCEMENTS_CHANNEL_ID/u);
    });
  });

  describe("OPS_CHANNEL_ID", () => {
    it("is optional, off by default", () => {
      expect(loadConfig(OK).opsChannelId).toBeUndefined();
    });

    it("reads a snowflake", () => {
      expect(loadConfig({ ...OK, OPS_CHANNEL_ID: "12345678901234567" }).opsChannelId).toBe("12345678901234567");
    });

    it("rejects a malformed id", () => {
      expect(() => loadConfig({ ...OK, OPS_CHANNEL_ID: "not-a-snowflake" })).toThrow(/OPS_CHANNEL_ID/u);
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

  it.each(["CLAN_TEXT_CATEGORY_ID", "CLAN_VOICE_CATEGORY_ID", "LINKED_ROLE_ID", "ALPHA_ROLE_ID"])(
    "⚠️ refuses to start without %s (spec §9.1)", (key) => {
      expect(() => loadConfig({ ...OK, [key]: undefined })).toThrow(key);
      expect(() => loadConfig({ ...OK, [key]: "" })).toThrow(key);
    },
  );
  it("rejects a malformed clan category or role id at load, not at first use", () => {
    expect(() => loadConfig({ ...OK, LINKED_ROLE_ID: "000000000000000000" })).toThrow(/LINKED_ROLE_ID/u);
    expect(() => loadConfig({ ...OK, CLAN_TEXT_CATEGORY_ID: "abc" })).toThrow(/CLAN_TEXT_CATEGORY_ID/u);
  });
  it("reads the three ids", () => {
    expect(loadConfig(OK)).toMatchObject({
      clanTextCategoryId: "12345678901234567", clanVoiceCategoryId: "22345678901234567", linkedRoleId: "32345678901234567",
    });
  });
  it("reads the @Alpha role id", () => {
    expect(loadConfig(OK)).toMatchObject({ alphaRoleId: "42345678901234567" });
  });

  describe("BAN_DRY_RUN", () => {
    it("⚠️ defaults TRUE — real bans require explicitly setting it to \"false\"", () => {
      expect(loadConfig(OK).banDryRun).toBe(true);
    });

    it('"false" turns dry-run OFF — bans become real', () => {
      expect(loadConfig({ ...OK, BAN_DRY_RUN: "false" }).banDryRun).toBe(false);
    });

    // ⚠️ These are the exact shapes an operator would reasonably type expecting
    // to turn real bans on. If the parse ever regresses to something that
    // doesn't trim/lowercase, every one of these silently STAYS dry-run —
    // the safe direction, but the operator believes otherwise and nothing
    // says so.
    it('"FALSE" and whitespace-padded "false" also turn dry-run off, normalized before the comparison', () => {
      expect(loadConfig({ ...OK, BAN_DRY_RUN: "FALSE" }).banDryRun).toBe(false);
      expect(loadConfig({ ...OK, BAN_DRY_RUN: " false " }).banDryRun).toBe(false);
    });

    // ⚠️ Anything that is NOT the normalized string "false" must leave real
    // bans OFF. This is the inversion-proof set: a parse accidentally written
    // as `=== "true"` would pass every test above and still let every one of
    // these enforce for real.
    it.each(["0", "no", "off", "", "true", "1"])(
      '%j does NOT turn dry-run off — only "false" does', (raw) => {
        expect(loadConfig({ ...OK, BAN_DRY_RUN: raw }).banDryRun).toBe(true);
      },
    );
  });

  describe("ENFORCEMENT_TICK / NITRADO_TOKEN", () => {
    it("defaults off", () => {
      expect(loadConfig(OK).enforcementTick).toBe(false);
    });

    it('"1" and "true" both turn it on, matching the other boolean flags in this file', () => {
      expect(loadConfig({ ...OK, ENFORCEMENT_TICK: "1", NITRADO_TOKEN: "nt" }).enforcementTick).toBe(true);
      expect(loadConfig({ ...OK, ENFORCEMENT_TICK: "true", NITRADO_TOKEN: "nt" }).enforcementTick).toBe(true);
    });

    it("⚠️ on without a token refuses to load — an enforcer that cannot authenticate would attempts-out and permanently fail every pending ban", () => {
      expect(() => loadConfig({ ...OK, ENFORCEMENT_TICK: "1" })).toThrow(/NITRADO_TOKEN/u);
      expect(() => loadConfig({ ...OK, ENFORCEMENT_TICK: "1", NITRADO_TOKEN: "  " })).toThrow(/NITRADO_TOKEN/u);
    });
  });

  describe("UNLINKED_PC_BAN / ENFORCEMENT_TICK", () => {
    it("defaults off", () => {
      expect(loadConfig(OK).unlinkedPcBan).toBe(false);
    });

    // ⚠️ Anything that is NOT "1" or "true" must leave the gate off. This is
    // the inversion-proof case: ENFORCEMENT_TICK=true once silently left that
    // tick off because only the literal "1" was accepted — the same parse is
    // reused here, so a value like "yes" must fail to turn PC bans on, not
    // succeed silently.
    it('a value that is neither "1" nor "true" leaves it off', () => {
      expect(loadConfig({ ...OK, UNLINKED_PC_BAN: "yes" }).unlinkedPcBan).toBe(false);
    });

    it('"1" and "true" both turn it on, matching the other boolean flags in this file', () => {
      expect(loadConfig({ ...OK, UNLINKED_PC_BAN: "1", ENFORCEMENT_TICK: "1", NITRADO_TOKEN: "nt" }).unlinkedPcBan).toBe(true);
      expect(loadConfig({ ...OK, UNLINKED_PC_BAN: "true", ENFORCEMENT_TICK: "1", NITRADO_TOKEN: "nt" }).unlinkedPcBan).toBe(true);
    });

    it('"TRUE" also turns it on — case-insensitive, like the other flags in this file', () => {
      expect(loadConfig({ ...OK, UNLINKED_PC_BAN: "TRUE", ENFORCEMENT_TICK: "1", NITRADO_TOKEN: "nt" }).unlinkedPcBan).toBe(true);
    });

    it("⚠️ on without ENFORCEMENT_TICK refuses to load — pcBanTick's rows would pile up with nothing to ever apply them", () => {
      expect(() => loadConfig({ ...OK, UNLINKED_PC_BAN: "1" })).toThrow(/UNLINKED_PC_BAN is on but ENFORCEMENT_TICK is off/u);
    });

    it("on with ENFORCEMENT_TICK (and its NITRADO_TOKEN requirement satisfied) loads fine", () => {
      expect(() => loadConfig({ ...OK, UNLINKED_PC_BAN: "1", ENFORCEMENT_TICK: "1", NITRADO_TOKEN: "nt" })).not.toThrow();
    });
  });
});
