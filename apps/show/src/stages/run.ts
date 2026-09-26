import type { Database } from "@factions/db";
import type { ShowStage } from "@factions/domain";
import type { Discord } from "../engine/publish/discord.js";
import type { VoicedEpisode } from "../produce/voice.js";
import type { ScriptResult } from "../script/write-script.js";
import { buildFacebookCaption } from "../engine/publish/facebook/buildFacebookCaption.js";
import { buildVideoMeta } from "../engine/publish/youtube/buildVideoMeta.js";
import { collectNames } from "../produce/names.js";
import { redactContext, type Redaction } from "../screening/redact.js";
import type { Verdict } from "../screening/store.js";
import { buildStoryContext } from "../story/context.js";
import type { StoryContext } from "../story/types.js";
import { episodeCode } from "../weeks.js";
import { advance, createEpisode, getEpisode, recordFailure, setFields, TERMINAL_STAGES, type EpisodeRow } from "./store.js";
import { alertMessage, draftMarker, draftMessage, forumThreadName, heldMessage, publicCopy, transcriptMessages } from "./text.js";

export type YouTubeOps = {
  /** An earlier upload of THIS cut: exact title and exact description. */
  findUpload(title: string, description: string): Promise<string | null>;
  upload(o: { filePath: string; title: string; description: string }): Promise<string>; // always unlisted
  ensureInPlaylist(videoId: string): Promise<void>;
  setPublic(videoId: string): Promise<void>;
  waitProcessed(videoId: string): Promise<boolean>;
};
export type FacebookOps = { find(link: string): Promise<string | null>; upload(o: { filePath: string; description: string }): Promise<string> };
export type StageDeps = {
  db: Database;
  now: () => Date;
  staffTags: string[];
  screen: (texts: string[]) => Promise<Map<string, Verdict>>;
  writeScript: (ctx: StoryContext, blocked: string[], allowed: string[]) => Promise<ScriptResult>;
  voice: (ep: { weekStart: string; narrative: string; context: StoryContext }) => Promise<VoicedEpisode>;
  render: (ep: { voiced: VoicedEpisode; context: StoryContext }) => Promise<string>;
  readFile: (p: string) => Buffer;
  youtube: YouTubeOps;
  discord: Discord;
  facebook: FacebookOps | null;
  cfg: { guildId: string; opsChannelId: string | null; forumChannelId: string; requireApproval: boolean; approverIds: string[]; discordInvite: string };
  log: (line: string) => void;
};
export type StoredReport = { redactions: Redaction[]; blocked: string[]; allowed: string[]; scriptReasons?: string[]; scriptAttempts?: number };
export type RunOutcome = "done" | "waiting" | "terminal" | "failed";
export const ALERT_AT_ATTEMPTS = 3;

type Step = (deps: StageDeps, row: EpisodeRow) => Promise<EpisodeRow | "wait">;

const ctxOf = (row: EpisodeRow) => row.context as StoryContext;
const reportOf = (row: EpisodeRow) => (row.screeningReport ?? { redactions: [], blocked: [], allowed: [] }) as StoredReport;
export const codeOf = (row: EpisodeRow) => episodeCode(row.seasonNumber, row.episodeNumber);
const voiceIn = (row: EpisodeRow) => ({ weekStart: row.weekStart.toISOString(), narrative: row.narrative!, context: ctxOf(row) });

/** Best-effort: an ops note that cannot be posted is logged, never a stage failure. */
export async function notifyOps(deps: StageDeps, msg: Parameters<Discord["post"]>[1]): Promise<void> {
  if (!deps.cfg.opsChannelId) { deps.log(`ops (no OPS_CHANNEL_ID): ${msg.content ?? ""}`); return; }
  try { await deps.discord.post(deps.cfg.opsChannelId, msg); } catch (e) { deps.log(`ops post failed: ${(e as Error).message}`); }
}

const context: Step = async (deps, row) => {
  const { context: raw, texts } = await buildStoryContext(deps.db, { weekStart: row.weekStart, staffTags: deps.staffTags, previous: "db" });
  // ⚠️ Fails closed: a screen that throws fails the stage; nothing unscreened is ever stored.
  const entries = texts.entries();
  const verdicts = await deps.screen(entries.map((e) => e.text));
  // ⚠️ Fails closed regardless of which screen is injected: a verdict missing for any
  // registered text must never be treated as silently allowed.
  for (const e of entries) if (!verdicts.has(e.text)) throw new Error(`screen returned no verdict for "${e.text}"`);
  const allowed = [...verdicts].filter(([, v]) => v.verdict === "allow" && v.source === "operator").map(([t]) => t);
  const { context: screened, report, blocked } = redactContext(raw, texts.entries(), verdicts);
  // The blocked list is persisted here: the script stage may run in a later process (plan 2 parked item).
  const stored: StoredReport = { redactions: report.redactions, blocked, allowed };
  return advance(deps.db, row.weekStart, "context", { context: screened, screeningReport: stored });
};

const scripted: Step = async (deps, row) => {
  const rep = reportOf(row);
  const result = await deps.writeScript(ctxOf(row), rep.blocked, rep.allowed);
  if (!result.ok) {
    const held = await advance(deps.db, row.weekStart, "held", { screeningReport: { ...rep, scriptReasons: result.reasons, scriptAttempts: result.attempts } });
    await notifyOps(deps, heldMessage({ code: codeOf(row), weekStart: row.weekStart, reasons: result.reasons, blocked: rep.blocked }));
    return held;
  }
  return advance(deps.db, row.weekStart, "scripted", {
    narrative: result.narrative, title: result.title, storylines: result.storylines,
    screeningReport: { ...rep, scriptReasons: result.reasons, scriptAttempts: result.attempts },
  });
};

const voiced: Step = async (deps, row) => {
  await deps.voice(voiceIn(row));
  return advance(deps.db, row.weekStart, "voiced");
};

const rendered: Step = async (deps, row) => {
  // A cache hit: the voiced stage's files are reused, no TTS is paid twice.
  const v = await deps.voice(voiceIn(row));
  await deps.render({ voiced: v, context: ctxOf(row) });
  return advance(deps.db, row.weekStart, "rendered");
};

export const APPROVE = "✅";
export const REJECT = "❌";
const watchUrl = (id: string) => `https://youtu.be/${id}`;

const uploaded: Step = async (deps, row) => {
  // ⚠️ The dash net applies to every string that leaves this process (global constraint): the
  // title, and below the description and transcript that feed it, all go through publicCopy.
  const meta = buildVideoMeta({ code: codeOf(row), subtitle: publicCopy(row.title!), transcript: publicCopy(row.narrative!) });
  // ⚠️ Post first, row second (spec §8.3); an upload a crash left unrecorded is found by its exact
  // title and description, so an older cut of the same week (after --force) is never adopted.
  let id = row.youtubeVideoId ?? (await deps.youtube.findUpload(meta.title, meta.description));
  if (!id) {
    const filePath = await deps.render({ voiced: await deps.voice(voiceIn(row)), context: ctxOf(row) });
    id = await deps.youtube.upload({ filePath, title: meta.title, description: meta.description });
  }
  if (row.youtubeVideoId !== id) await setFields(deps.db, row.weekStart, { youtubeVideoId: id });
  return advance(deps.db, row.weekStart, "uploaded", { youtubeVideoId: id });
};

const awaitingApproval: Step = async (deps, row) => {
  const ops = deps.cfg.opsChannelId;
  if (!ops) throw new Error("approval is on but OPS_CHANNEL_ID is unset");
  let id = row.draftMessageId;
  if (!id) {
    const me = await deps.discord.me();
    const marker = draftMarker(row.weekStart, row.narrative!);
    id = (await deps.discord.recentMessages(ops, 50)).find((m) => m.authorId === me && m.content.includes(marker))?.id ?? null;
  }
  if (!id) {
    const rep = reportOf(row);
    const posted = await deps.discord.post(ops, draftMessage({
      weekStart: row.weekStart, code: codeOf(row), subtitle: row.title!, youtubeVideoId: row.youtubeVideoId!,
      narrative: row.narrative!, redactions: rep.redactions, scriptAttempts: rep.scriptAttempts ?? 1,
    }));
    id = posted.id;
    await setFields(deps.db, row.weekStart, { draftMessageId: id });
    // Convenience only: the approver clicks rather than hunts for the emoji. Not counted (the bot is no approver).
    try { await deps.discord.react(ops, id, APPROVE); await deps.discord.react(ops, id, REJECT); } catch (e) { deps.log(`draft reactions: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return advance(deps.db, row.weekStart, "awaiting_approval", { draftMessageId: id });
};

const approved: Step = async (deps, row) => {
  // ⚠️ A posted draft is always decided by its reactions, even after SHOW_REQUIRE_APPROVAL is
  // turned off: flipping the flag must never make an episode already in review public with no ✅.
  const draft = row.draftMessageId;
  if (!draft) {
    if (!deps.cfg.requireApproval) return advance(deps.db, row.weekStart, "approved");
    throw new Error("approval is on but no draft was posted");
  }
  const ops = deps.cfg.opsChannelId;
  if (!ops) throw new Error("a draft is awaiting approval but OPS_CHANNEL_ID is unset");
  const me = await deps.discord.me();
  const approvers = new Set(deps.cfg.approverIds);
  // ⚠️ The bot's own reaction (added as a convenience so an approver can click rather than hunt
  // for the emoji) is never a vote, even if the bot's id somehow ends up in approverIds.
  const by = async (emoji: string) => (await deps.discord.reactionUserIds(ops, draft, emoji)).filter((u) => u !== me).find((u) => approvers.has(u)) ?? null;
  // ⚠️ ❌ is read first and wins: when two approvers disagree, nothing goes public.
  const rejecter = await by(REJECT);
  if (rejecter) return advance(deps.db, row.weekStart, "rejected", { rejectedByDiscordId: rejecter, rejectedAt: deps.now() });
  const approver = await by(APPROVE);
  if (approver) return advance(deps.db, row.weekStart, "approved", { approvedByDiscordId: approver, approvedAt: deps.now() });
  return "wait";
};

const makePublic: Step = async (deps, row) => {
  await deps.youtube.setPublic(row.youtubeVideoId!);
  // ⚠️ Playlist membership happens here, not at upload (spec §2.6): nothing is public until an
  // approver reacts ✅, and an unlisted video sitting in a public playlist is discoverable —
  // a rejected episode must never end up there.
  await deps.youtube.ensureInPlaylist(row.youtubeVideoId!);
  return advance(deps.db, row.weekStart, "public", { youtubePublicAt: deps.now() });
};

const posted: Step = async (deps, row) => {
  const vid = row.youtubeVideoId!;
  // Spec §9.1: a thread posted before processing embeds a "processing" card forever.
  if (!(await deps.youtube.waitProcessed(vid))) throw new Error("YouTube has not finished processing the video yet");
  const name = forumThreadName(codeOf(row), row.title!);
  let thread = row.forumThreadId;
  if (!thread) {
    // ⚠️ A name match alone is not this cut's thread: after --repost the old cut's thread has the
    // same name, and its messages would count as this transcript. Only a thread whose starter is
    // THIS video's link is adopted; in a forum the starter message's id is the thread's id.
    for (const t of await deps.discord.findForumThreads(deps.cfg.guildId, deps.cfg.forumChannelId, name)) {
      if ((await deps.discord.message(t, t))?.content === watchUrl(vid)) { thread = t; break; }
    }
  }
  if (!thread) thread = (await deps.discord.createForumThread(deps.cfg.forumChannelId, name, { content: watchUrl(vid) })).threadId;
  if (row.forumThreadId !== thread) await setFields(deps.db, row.weekStart, { forumThreadId: thread });
  const v = await deps.voice(voiceIn(row));
  const messages = transcriptMessages({ narrative: row.narrative!, names: collectNames(ctxOf(row)).names, mp3: deps.readFile(v.mp3Path) });
  const me = await deps.discord.me();
  const mine = (await deps.discord.recentMessages(thread, 20)).filter((m) => m.authorId === me);
  // ⚠️ The first bot message is the watch link; the rest are the transcript. Compare against
  // 1 + messages.length (never a flat 2) so a crash partway through a multi-message transcript
  // resumes at the right message instead of skipping one or re-posting the mp3.
  if (mine.length < 1 + messages.length) {
    // Math.max: a thread whose starter was deleted has no link message to skip (slice(-1) would re-post only the last).
    for (const msg of messages.slice(Math.max(0, mine.length - 1))) {
      await deps.discord.post(thread, msg);
    }
  }
  return advance(deps.db, row.weekStart, "posted", { forumThreadId: thread, discordPostedAt: deps.now() });
};

const done: Step = async (deps, row) => {
  if (!deps.facebook) return advance(deps.db, row.weekStart, "done");
  const link = watchUrl(row.youtubeVideoId!);
  try {
    let id = row.facebookVideoId ?? (await deps.facebook.find(link));
    if (!id) {
      const filePath = await deps.render({ voiced: await deps.voice(voiceIn(row)), context: ctxOf(row) });
      id = await deps.facebook.upload({ filePath, description: buildFacebookCaption({ code: codeOf(row), subtitle: publicCopy(row.title!), youtubeVideoId: row.youtubeVideoId!, discordInvite: deps.cfg.discordInvite }) });
    }
    return advance(deps.db, row.weekStart, "done", { facebookVideoId: id, facebookPostedAt: deps.now() });
  } catch (e) {
    // Spec §8.3: best-effort, as in the KOTH show. Logged in the row, never holds the episode.
    const msg = e instanceof Error ? e.message : String(e);
    return advance(deps.db, row.weekStart, "done", { lastError: `facebook: ${msg}` });
  }
};

const PUBLISH_STEPS: Partial<Record<ShowStage, Step>> = {
  uploaded, awaiting_approval: awaitingApproval, approved, public: makePublic, posted, done,
};

const STEPS: Partial<Record<ShowStage, Step>> = { context, scripted, voiced, rendered };

export function nextStage(row: EpisodeRow, cfg: StageDeps["cfg"]): ShowStage | null {
  switch (row.stage) {
    case "new": return "context";
    case "context": return "scripted";
    case "scripted": return "voiced";
    case "voiced": return "rendered";
    case "rendered": return "uploaded";
    case "uploaded": return cfg.requireApproval ? "awaiting_approval" : "approved";
    case "awaiting_approval": return "approved";
    case "approved": return "public";
    case "public": return "posted";
    case "posted": return "done";
    default: return null;
  }
}

/** Run from the row's stage until a step waits, fails, or the row is terminal (spec §8.1 step 4). */
export async function runStages(deps: StageDeps, weekStart: Date): Promise<{ outcome: RunOutcome; row: EpisodeRow }> {
  let row = (await getEpisode(deps.db, weekStart)) ?? (await createEpisode(deps.db, weekStart));
  for (;;) {
    if (row.stage === "done") return { outcome: "done", row };
    if (TERMINAL_STAGES.includes(row.stage)) return { outcome: "terminal", row };
    const next = nextStage(row, deps.cfg)!;
    try {
      const step = STEPS[next] ?? PUBLISH_STEPS[next];
      if (!step) throw new Error(`no step for stage ${next}`);
      const r = await step(deps, row);
      if (r === "wait") return { outcome: "waiting", row };
      deps.log(`${codeOf(row)}: ${row.stage} -> ${r.stage}`);
      row = r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const attempts = await recordFailure(deps.db, weekStart, msg);
      deps.log(`${codeOf(row)}: stage "${next}" failed (attempt ${attempts}): ${msg}`);
      // ⚠️ Exactly at 3, so the alert is not repeated by every later timer run (spec §8.3).
      if (attempts === ALERT_AT_ATTEMPTS) {
        // ⚠️ At the "context" stage there is no blocked list yet to scrub the raw error
        // against (it is produced BY this stage), so a screen/context failure must never
        // put its error text in the ops channel: a fixed placeholder stands in for it.
        const errForOps = next === "context" ? "see last_error on the host" : msg;
        await notifyOps(deps, alertMessage({ code: codeOf(row), stage: next, attempts, error: errForOps, blocked: reportOf(row).blocked }));
      }
      return { outcome: "failed", row: (await getEpisode(deps.db, weekStart))! };
    }
  }
}
