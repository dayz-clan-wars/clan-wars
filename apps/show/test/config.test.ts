import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, loadRenderConfig, DEFAULT_MODEL, loadServiceConfig, SHOW_LOCK_KEY } from "../src/config.js";

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

const renderBase = {
  ELEVENLABS_API_KEY: "eleven-key",
  ELEVENLABS_BORIS_VOICE_ID: "boris-voice",
  ELEVENLABS_PAVEL_VOICE_ID: "pavel-voice",
};

describe("loadRenderConfig", () => {
  const tmpFiles: string[] = [];
  afterEach(() => {
    for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
  });
  const tmpFile = (content: string): string => {
    const p = path.join(os.tmpdir(), `show-pronunciations-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, content);
    tmpFiles.push(p);
    return p;
  };

  it("defaults everything but the three required ElevenLabs keys", () => {
    expect(loadRenderConfig(renderBase)).toEqual({
      elevenApiKey: "eleven-key",
      borisVoiceId: "boris-voice",
      pavelVoiceId: "pavel-voice",
      elevenModel: "eleven_multilingual_v2",
      pronunciationModel: DEFAULT_MODEL,
      rhubarbPath: "rhubarb",
      ffmpegPath: "ffmpeg",
      cacheDir: "/var/lib/clan-wars-show",
      cacheDirSet: false,
      discordInvite: "discord.gg/TJu4XP25nr",
      pronunciationOverrides: {},
    });
  });

  it.each(["ELEVENLABS_API_KEY", "ELEVENLABS_BORIS_VOICE_ID", "ELEVENLABS_PAVEL_VOICE_ID"])("requires %s", (key) => {
    const env: Record<string, string> = { ...renderBase };
    delete env[key];
    expect(() => loadRenderConfig(env)).toThrow(key);
  });

  it("reads overrides for the model, binaries, cache dir and invite", () => {
    const c = loadRenderConfig({
      ...renderBase,
      ELEVENLABS_MODEL: "eleven_turbo_v2",
      SHOW_PRONUNCIATION_MODEL: "a/b",
      RHUBARB_PATH: "/opt/rhubarb/rhubarb",
      FFMPEG_PATH: "/opt/ffmpeg/ffmpeg",
      SHOW_CACHE_DIR: "/tmp/show-cache",
      SHOW_DISCORD_INVITE: "discord.gg/other",
    });
    expect(c).toMatchObject({
      elevenModel: "eleven_turbo_v2",
      pronunciationModel: "a/b",
      rhubarbPath: "/opt/rhubarb/rhubarb",
      ffmpegPath: "/opt/ffmpeg/ffmpeg",
      cacheDir: "/tmp/show-cache",
      cacheDirSet: true,
      discordInvite: "discord.gg/other",
    });
  });

  it("parses a pronunciation overrides file", () => {
    const p = tmpFile(JSON.stringify({ Boris: "BOR-iss" }));
    const c = loadRenderConfig({ ...renderBase, PRONUNCIATIONS_PATH: p });
    expect(c.pronunciationOverrides).toEqual({ Boris: "BOR-iss" });
  });

  it("throws on a missing overrides file", () => {
    expect(() => loadRenderConfig({ ...renderBase, PRONUNCIATIONS_PATH: "/no/such/file.json" })).toThrow();
  });

  it("throws on invalid JSON in the overrides file", () => {
    const p = tmpFile("not json");
    expect(() => loadRenderConfig({ ...renderBase, PRONUNCIATIONS_PATH: p })).toThrow();
  });

  it("throws on non-object JSON in the overrides file", () => {
    const p = tmpFile(JSON.stringify(["a", "b"]));
    expect(() => loadRenderConfig({ ...renderBase, PRONUNCIATIONS_PATH: p })).toThrow();
  });
});

const full = {
  DATABASE_URL: "postgres://db", OPENROUTER_API_KEY: "k", SHOW_ENABLED: "1",
  ELEVENLABS_API_KEY: "e", ELEVENLABS_BORIS_VOICE_ID: "b", ELEVENLABS_PAVEL_VOICE_ID: "p",
  DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "111111111111111111", OPS_CHANNEL_ID: "222222222222222222",
  SHOW_FORUM_CHANNEL_ID: "1553136654808784986", SHOW_APPROVER_DISCORD_IDS: "333333333333333333, 444444444444444444",
  YOUTUBE_CLIENT_ID: "ci", YOUTUBE_CLIENT_SECRET: "cs", YOUTUBE_REFRESH_TOKEN: "rt", YOUTUBE_PLAYLIST_ID: "PL1",
};

describe("loadServiceConfig", () => {
  it("is off by default and then needs only DATABASE_URL", () => {
    expect(loadServiceConfig({ DATABASE_URL: "postgres://db" })).toEqual({ enabled: false, databaseUrl: "postgres://db" });
    expect(loadServiceConfig({ DATABASE_URL: "postgres://db", SHOW_ENABLED: "0" }).enabled).toBe(false);
  });

  it("reads a full enabled config with approval on by default", () => {
    const c = loadServiceConfig(full);
    if (!c.enabled) throw new Error("expected enabled");
    expect(c).toMatchObject({
      guildId: "111111111111111111", opsChannelId: "222222222222222222", forumChannelId: "1553136654808784986",
      requireApproval: true, approverIds: ["333333333333333333", "444444444444444444"],
      youtube: { clientId: "ci", clientSecret: "cs", refreshToken: "rt", playlistId: "PL1" }, facebook: null,
    });
    expect(c.render.cacheDir).toBe("/var/lib/clan-wars-show");
  });

  it("accepts true/1 for SHOW_ENABLED and 0/false for SHOW_REQUIRE_APPROVAL", () => {
    const c = loadServiceConfig({ ...full, SHOW_ENABLED: "true", SHOW_REQUIRE_APPROVAL: "false", SHOW_APPROVER_DISCORD_IDS: "" });
    expect(c.enabled && c.requireApproval).toBe(false);
  });

  it.each([
    ["SHOW_FORUM_CHANNEL_ID"], ["DISCORD_TOKEN"], ["DISCORD_GUILD_ID"], ["YOUTUBE_REFRESH_TOKEN"], ["YOUTUBE_PLAYLIST_ID"], ["ELEVENLABS_API_KEY"],
  ])("fails when enabled without %s", (key) => {
    expect(() => loadServiceConfig({ ...full, [key]: "" })).toThrow(new RegExp(key, "u"));
  });

  it("fails when approval is on without OPS_CHANNEL_ID or approvers", () => {
    expect(() => loadServiceConfig({ ...full, OPS_CHANNEL_ID: "" })).toThrow(/OPS_CHANNEL_ID/u);
    expect(() => loadServiceConfig({ ...full, SHOW_APPROVER_DISCORD_IDS: "" })).toThrow(/SHOW_APPROVER_DISCORD_IDS/u);
  });

  it("rejects a snowflake that is not one", () => {
    expect(() => loadServiceConfig({ ...full, SHOW_APPROVER_DISCORD_IDS: "333333333333333333,bob" })).toThrow(/SHOW_APPROVER_DISCORD_IDS/u);
    expect(() => loadServiceConfig({ ...full, SHOW_FORUM_CHANNEL_ID: "forum" })).toThrow(/SHOW_FORUM_CHANNEL_ID/u);
  });

  it("wants both Facebook keys or neither", () => {
    const c = loadServiceConfig({ ...full, FACEBOOK_PAGE_ID: "9", FACEBOOK_PAGE_ACCESS_TOKEN: "fb" });
    expect(c.enabled && c.facebook).toEqual({ pageId: "9", accessToken: "fb" });
    expect(() => loadServiceConfig({ ...full, FACEBOOK_PAGE_ID: "9" })).toThrow(/FACEBOOK/u);
  });

  it("uses a lock key distinct from the bot's instance lock", () => {
    expect(SHOW_LOCK_KEY).toBe(8_531_208);
  });
});
