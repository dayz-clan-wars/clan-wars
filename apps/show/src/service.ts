import fs from "node:fs";
import { acquireAdvisoryLock, createClient, type Database } from "@factions/db";
import { loadServiceConfig, SHOW_LOCK_KEY, type ServiceConfig } from "./config.js";
import { createChat } from "./engine/llm/openrouter.js";
import { createDiscord } from "./engine/publish/discord.js";
import { findPageVideoByLink, uploadPageVideo } from "./engine/publish/facebook/facebook.js";
import { accessTokenFromRefresh, addToPlaylist, findUploadByTitle, playlistHas, setPrivacy, uploadVideo, waitForVideoProcessed } from "./engine/publish/youtube/youtube.js";
import { spawnRun, type Run } from "./engine/run.js";
import { renderEpisode } from "./produce/render.js";
import { voiceEpisode } from "./produce/voice.js";
import { createModerator } from "./screening/moderate.js";
import { screenTexts } from "./screening/screen.js";
import { PgScreeningStore } from "./screening/store.js";
import { writeScript } from "./script/write-script.js";
import { forceWeek } from "./stages/store.js";
import { pickWeek } from "./stages/pick.js";
import { runStages, type StageDeps } from "./stages/run.js";
import { PgPronunciationStore } from "./stores/pronunciations.js";

type On = Extract<ServiceConfig, { enabled: true }>;
export type ServiceArgs = { week?: Date; force: boolean; repost: boolean };
export type ServiceIo = {
  lock: (url: string, key: number) => Promise<{ release(): Promise<void> } | null>;
  openDb: (url: string) => Database;
  buildDeps: (db: Database, cfg: On) => StageDeps;
  now: () => Date;
  log: (s: string) => void;
};

/** The real wiring: every external effect the stages make, from config. */
export function realDeps(db: Database, cfg: On): StageDeps {
  const chat = createChat({ apiKey: cfg.base.openrouterApiKey });
  const moderate = createModerator({ chat, model: cfg.base.moderationModel });
  const screeningStore = new PgScreeningStore(db);
  const runImpl: Run = (cmd, args, opts) => spawnRun(cmd === "ffmpeg" ? cfg.render.ffmpegPath : cmd, args, opts);
  const yt = cfg.youtube;
  // A fresh access token per call: a render-then-upload run outlives the one-hour token.
  const token = () => accessTokenFromRefresh({ clientId: yt.clientId, clientSecret: yt.clientSecret, refreshToken: yt.refreshToken });
  const fb = cfg.facebook;
  return {
    db,
    now: () => new Date(),
    staffTags: cfg.base.staffTags,
    screen: (texts) => screenTexts(texts, { store: screeningStore, moderate }),
    writeScript: (ctx, blocked, allowed) => writeScript(ctx, blocked, {
      generate: (system, user) => chat({ model: cfg.base.scriptModel, temperature: 0.9, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      moderate, allowed,
    }),
    voice: (ep) => voiceEpisode({
      chat, pronunciationModel: cfg.render.pronunciationModel, store: new PgPronunciationStore(db), overrides: cfg.render.pronunciationOverrides,
      elevenApiKey: cfg.render.elevenApiKey, elevenModel: cfg.render.elevenModel, borisVoiceId: cfg.render.borisVoiceId, pavelVoiceId: cfg.render.pavelVoiceId,
      cacheDir: cfg.render.cacheDir, rhubarbPath: cfg.render.rhubarbPath, runImpl,
    }, ep),
    render: (ep) => renderEpisode({ cacheDir: cfg.render.cacheDir, discordInvite: cfg.render.discordInvite, runImpl }, ep),
    readFile: (p) => fs.readFileSync(p),
    youtube: {
      findUpload: async (title) => findUploadByTitle({ accessToken: await token(), title }),
      upload: async ({ filePath, title, description }) => uploadVideo({ accessToken: await token(), filePath, title, description, privacy: "unlisted" }),
      ensureInPlaylist: async (videoId) => {
        const accessToken = await token();
        if (!(await playlistHas({ accessToken, playlistId: yt.playlistId, videoId }))) await addToPlaylist({ accessToken, playlistId: yt.playlistId, videoId });
      },
      setPublic: async (videoId) => setPrivacy({ accessToken: await token(), videoId, privacy: "public" }),
      waitProcessed: async (videoId) => waitForVideoProcessed({ accessToken: await token(), videoId }),
    },
    discord: createDiscord({ token: cfg.discordToken }),
    facebook: fb ? {
      find: (link) => findPageVideoByLink({ pageId: fb.pageId, accessToken: fb.accessToken, link }),
      upload: ({ filePath, description }) => uploadPageVideo({ pageId: fb.pageId, accessToken: fb.accessToken, filePath, description }),
    } : null,
    cfg: {
      guildId: cfg.guildId, opsChannelId: cfg.opsChannelId, forumChannelId: cfg.forumChannelId,
      requireApproval: cfg.requireApproval, approverIds: cfg.approverIds, discordInvite: cfg.render.discordInvite,
    },
    log: (s) => console.log(s),
  };
}

const REAL_IO: ServiceIo = {
  lock: acquireAdvisoryLock,
  openDb: (url) => createClient(url),
  buildDeps: realDeps,
  now: () => new Date(),
  log: (s) => console.log(s),
};

/** One run, exactly what the timer does (spec §8.1, §10). Returns the process exit code. */
export async function serviceMain(args: ServiceArgs, env: NodeJS.ProcessEnv = process.env, io: ServiceIo = REAL_IO): Promise<number> {
  if (args.force && !args.week) { io.log("--force needs --week <date>"); return 2; }
  if (args.repost && !args.force) { io.log("--repost only goes with --force"); return 2; }
  const cfg = loadServiceConfig(env);
  // ⚠️ The same lock for timer and manual runs, so the two can never overlap (spec §2.5).
  const lock = await io.lock(cfg.databaseUrl, SHOW_LOCK_KEY);
  if (!lock) { io.log("another show run holds the lock; exiting"); return 0; }
  const db = io.openDb(cfg.databaseUrl);
  try {
    if (!cfg.enabled) { io.log("SHOW_ENABLED is off; nothing to do"); return 0; }
    if (args.force) {
      const r = await forceWeek(db, args.week!, { repost: args.repost });
      if (r === "public-needs-repost") { io.log("that episode is already public; add --repost to publish a new cut"); return 2; }
      io.log(r === "missing" ? "no row for that week yet; running it fresh" : "reset to new");
    }
    const week = args.week ?? (await pickWeek(db, io.now()));
    if (!week) { io.log("no week is ready"); return 0; }
    const { outcome, row } = await runStages(io.buildDeps(db, cfg), week);
    io.log(`${row.weekStart.toISOString().slice(0, 10)}: ${outcome} at ${row.stage}`);
    return outcome === "failed" ? 1 : 0;
  } finally {
    await lock.release();
    // Only close a client this function opened; the tests pass their own and keep it open.
    if (io === REAL_IO) await db.$client.end();
  }
}
