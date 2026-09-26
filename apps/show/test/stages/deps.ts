import type { Database } from "@factions/db";
import type { StageDeps } from "../../src/stages/run.js";
import type { Discord, OutMessage } from "../../src/engine/publish/discord.js";
import type { Verdict } from "../../src/screening/store.js";

export type Posted = { channelId: string; msg: OutMessage; id: string };

/** Every external effect recorded, nothing real. Override any field per test. */
export function fakeDeps(db: Database, over: Partial<StageDeps> = {}) {
  const posted: Posted[] = [];
  const reactions = new Map<string, string[]>(); // `${messageId}:${emoji}` -> user ids
  const threads: { id: string; forumId: string; name: string; first: OutMessage }[] = [];
  const uploads: { id: string; title: string; description: string }[] = [];
  const playlist = new Set<string>();
  const publicIds = new Set<string>();
  const fbVideos: { id: string; description: string }[] = [];
  const calls = { voice: 0, render: 0, script: 0 };
  let n = 0;
  const discord: Discord = {
    me: async () => "BOT",
    post: async (channelId, msg) => { const id = `m${++n}`; posted.push({ channelId, msg, id }); return { id }; },
    react: async (_c, m, e) => { reactions.set(`${m}:${e}`, [...(reactions.get(`${m}:${e}`) ?? []), "BOT"]); },
    reactionUserIds: async (_c, m, e) => reactions.get(`${m}:${e}`) ?? [],
    recentMessages: async (channelId) => posted.filter((p) => p.channelId === channelId).map((p) => ({ id: p.id, content: p.msg.content ?? "", authorId: "BOT", embeds: p.msg.embeds?.length ?? 0, attachments: p.msg.files?.length ?? 0 })),
    createForumThread: async (forumId, name, first) => { const id = `t${++n}`; threads.push({ id, forumId, name, first }); posted.push({ channelId: id, msg: first, id }); return { threadId: id }; },
    findForumThread: async (_g, forumId, name) => threads.find((t) => t.forumId === forumId && t.name === name)?.id ?? null,
  };
  const deps: StageDeps = {
    db,
    now: () => new Date("2026-09-28T07:00:00Z"),
    staffTags: ["ADM"],
    screen: async (texts) => new Map(texts.map((t) => [t, { verdict: "allow", source: "llm", reason: null } satisfies Verdict])),
    writeScript: async () => { calls.script++; return { ok: true, narrative: "Boris: Hello.\nPavel: Hi.", title: "The Curse", storylines: [], attempts: 1, reasons: [] }; },
    voice: async (ep) => { calls.voice++; return { key: `k-${ep.weekStart}`, mp3Path: "/cache/k/episode.mp3", totalSec: 10, segASpan: { startSec: 1, durSec: 8 }, outroSpan: { startSec: 9, durSec: 1 }, timeline: [] }; },
    render: async () => { calls.render++; return "/cache/k/video.mp4"; },
    readFile: () => Buffer.from("BYTES"),
    youtube: {
      findUpload: async (title) => uploads.find((u) => u.title === title)?.id ?? null,
      upload: async ({ title, description }) => { const id = `yt${++n}`; uploads.push({ id, title, description }); return id; },
      ensureInPlaylist: async (id) => { playlist.add(id); },
      setPublic: async (id) => { publicIds.add(id); },
      waitProcessed: async () => true,
    },
    discord,
    facebook: {
      find: async (link) => fbVideos.find((v) => v.description.includes(link))?.id ?? null,
      upload: async ({ description }) => { const id = `fb${++n}`; fbVideos.push({ id, description }); return id; },
    },
    cfg: { guildId: "G", opsChannelId: "OPS", forumChannelId: "FORUM", requireApproval: true, approverIds: ["ADMIN1"], discordInvite: "discord.gg/TJu4XP25nr" },
    log: () => {},
    ...over,
  };
  return { deps, posted, reactions, threads, uploads, playlist, publicIds, fbVideos, calls };
}
