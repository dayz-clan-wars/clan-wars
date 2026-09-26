import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, loadRenderConfig, DEFAULT_MODEL } from "../src/config.js";

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
