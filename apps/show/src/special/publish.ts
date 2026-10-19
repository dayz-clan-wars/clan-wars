import fs from "node:fs";
import { cutHash } from "../engine/animation/episodeCache.js";
import { writeFileAtomic } from "../engine/atomicWrite.js";
import { buildVideoMeta } from "../engine/publish/youtube/buildVideoMeta.js";
import { APPROVE, REJECT, decideDraft } from "../stages/approval.js";
import type { StageDeps } from "../stages/run.js";
import { forumThreadName, publicCopy, transcriptMessages } from "../stages/text.js";
import type { Special } from "./load.js";
import { specialDraftMessage, specialFacebookCaption, specialMarker } from "./text.js";

// A special's publish (spec 2026-10-19-nasdara-promo-episode-design.md §5.2): the weekly stages'
// upload -> draft -> ✅ -> public -> forum -> Facebook, minus the `show_episodes` row. A row would
// collide with a real week and leak into next Monday's "Previously on", so the state lives in a
// JSON file beside the rendered files, written after every step.

export type SpecialState = {
  cut: string;
  youtubeVideoId?: string;
  draftMessageId?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  publicAt?: string;
  forumThreadId?: string;
  postedAt?: string;
  facebookVideoId?: string;
  facebookError?: string;
  doneAt?: string;
};
export type SpecialPublishDeps = Pick<StageDeps, "youtube" | "discord" | "facebook" | "cfg" | "now" | "log" | "readFile">;
export type SpecialOutcome = "done" | "waiting" | "rejected" | "cut-mismatch";
export type SpecialOut = { videoPath: string; mp3Path: string; statePath: string };

const watchUrl = (id: string) => `https://youtu.be/${id}`;
const CODE = "Special";

export async function publishSpecial(deps: SpecialPublishDeps, s: Special, out: SpecialOut): Promise<SpecialOutcome> {
  const cut = cutHash(s.narrative);
  let st: SpecialState = fs.existsSync(out.statePath) ? JSON.parse(fs.readFileSync(out.statePath, "utf8")) : { cut };
  // ⚠️ The ✅ was given to one cut. A changed script must never ride on that approval, or on that
  // cut's upload and thread: it gets a fresh --publish directory and its own review.
  if (st.cut !== cut) return "cut-mismatch";
  const save = (patch: Partial<SpecialState>) => { st = { ...st, ...patch }; writeFileAtomic(fs, out.statePath, JSON.stringify(st, null, 2)); };
  if (st.doneAt) return "done";
  if (st.rejectedBy) return "rejected";

  // 1. Upload, unlisted. ⚠️ Post first, state second: a crash in between is recovered by the exact title and description.
  const meta = buildVideoMeta({ code: CODE, subtitle: publicCopy(s.subtitle), transcript: publicCopy(`${s.descriptionLead}\n\n${s.narrative}`) });
  if (!st.youtubeVideoId) {
    const id = (await deps.youtube.findUpload(meta.title, meta.description))
      ?? (await deps.youtube.upload({ filePath: out.videoPath, title: meta.title, description: meta.description }));
    save({ youtubeVideoId: id });
  }
  const vid = st.youtubeVideoId!;

  // 2. The ops draft. ⚠️ No ops channel means no approval is possible, so fail rather than publish.
  const ops = deps.cfg.opsChannelId;
  if (!ops) throw new Error("a special needs OPS_CHANNEL_ID for its approval draft");
  if (!st.draftMessageId) {
    const me = await deps.discord.me();
    const marker = specialMarker(s.slug, s.narrative);
    let id = (await deps.discord.recentMessages(ops, 50)).find((m) => m.authorId === me && m.content.includes(marker))?.id ?? null;
    if (!id) {
      id = (await deps.discord.post(ops, specialDraftMessage({ subtitle: s.subtitle, youtubeVideoId: vid, narrative: s.narrative, marker }))).id;
      save({ draftMessageId: id });
      // Convenience only, as in the weekly stage: the bot's reactions are never votes.
      try { await deps.discord.react(ops, id, APPROVE); await deps.discord.react(ops, id, REJECT); } catch (e) { deps.log(`draft reactions: ${e instanceof Error ? e.message : String(e)}`); }
    }
    save({ draftMessageId: id });
  }

  // 3. The decision.
  if (!st.approvedBy) {
    const d = await decideDraft({ discord: deps.discord, approverIds: deps.cfg.approverIds }, ops, st.draftMessageId!);
    if (!d) { deps.log("waiting for ✅ on the ops draft"); return "waiting"; }
    if (d.decision === "rejected") { save({ rejectedBy: d.by, rejectedAt: deps.now().toISOString() }); return "rejected"; }
    save({ approvedBy: d.by, approvedAt: deps.now().toISOString() });
  }

  // 4. Public. ⚠️ Playlist only now, as in the weekly stage: an unlisted video in a public playlist is discoverable.
  if (!st.publicAt) {
    await deps.youtube.setPublic(vid);
    await deps.youtube.ensureInPlaylist(vid);
    save({ publicAt: deps.now().toISOString() });
  }

  // 5. The forum thread and transcript.
  if (!st.postedAt) {
    if (!(await deps.youtube.waitProcessed(vid))) throw new Error("YouTube has not finished processing the video yet");
    const name = forumThreadName(CODE, s.subtitle);
    let thread = st.forumThreadId ?? null;
    if (!thread) {
      // ⚠️ A name match alone is not this cut's thread; only one whose starter is this video's link.
      for (const t of await deps.discord.findForumThreads(deps.cfg.guildId, deps.cfg.forumChannelId, name)) {
        if ((await deps.discord.message(t, t))?.content === watchUrl(vid)) { thread = t; break; }
      }
    }
    if (!thread) thread = (await deps.discord.createForumThread(deps.cfg.forumChannelId, name, { content: watchUrl(vid) })).threadId;
    save({ forumThreadId: thread });
    const messages = transcriptMessages({ narrative: s.narrative, names: [], mp3: deps.readFile(out.mp3Path) });
    const me = await deps.discord.me();
    const mine = (await deps.discord.recentMessages(thread, 20)).filter((m) => m.authorId === me);
    // ⚠️ The first bot message is the watch link; resume the transcript where a crash left it.
    if (mine.length < 1 + messages.length) {
      for (const msg of messages.slice(Math.max(0, mine.length - 1))) await deps.discord.post(thread, msg);
    }
    save({ postedAt: deps.now().toISOString() });
  }

  // 6. Facebook, best-effort as in the weekly stage: logged in the state, never holds the episode.
  if (deps.facebook) {
    const link = watchUrl(vid);
    try {
      const id = st.facebookVideoId ?? (await deps.facebook.find(link)) ?? (await deps.facebook.upload({
        filePath: out.videoPath,
        description: specialFacebookCaption({ subtitle: s.subtitle, lines: s.facebookLines, youtubeVideoId: vid, discordInvite: deps.cfg.discordInvite }),
      }));
      save({ facebookVideoId: id });
    } catch (e) {
      save({ facebookError: e instanceof Error ? e.message : String(e) });
    }
  }
  save({ doneAt: deps.now().toISOString() });
  return "done";
}
