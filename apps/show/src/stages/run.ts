import type { Database } from "@factions/db";
import type { ShowStage } from "@factions/domain";
import type { Discord } from "../engine/publish/discord.js";
import type { VoicedEpisode } from "../produce/voice.js";
import type { ScriptResult } from "../script/write-script.js";
import { redactContext, type Redaction } from "../screening/redact.js";
import type { Verdict } from "../screening/store.js";
import { buildStoryContext } from "../story/context.js";
import type { StoryContext } from "../story/types.js";
import { episodeCode } from "../weeks.js";
import { advance, createEpisode, getEpisode, recordFailure, TERMINAL_STAGES, type EpisodeRow } from "./store.js";
import { alertMessage, heldMessage } from "./text.js";

export type YouTubeOps = {
  findUpload(title: string): Promise<string | null>;
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
  const verdicts = await deps.screen(texts.entries().map((e) => e.text));
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

// Task 9 fills these in.
const PUBLISH_STEPS: Partial<Record<ShowStage, Step>> = {};

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
      // ⚠️ Task 9 fills in PUBLISH_STEPS; until then this throws at "uploaded" and is
      // recorded as an ordinary stage failure, same as any other step's error.
      const step = STEPS[next] ?? PUBLISH_STEPS[next];
      if (!step) throw new Error(`no step for stage ${next}`);
      const r = await step(deps, row);
      if (r === "wait") return { outcome: "waiting", row };
      deps.log(`${codeOf(row)}: ${row.stage} -> ${r.stage}`);
      row = r;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const attempts = await recordFailure(deps.db, weekStart, msg);
      deps.log(`${codeOf(row)}: stage "${next}" failed (attempt ${attempts}): ${msg}`);
      // ⚠️ Exactly at 3, so the alert is not repeated by every later timer run (spec §8.3).
      if (attempts === ALERT_AT_ATTEMPTS) {
        await notifyOps(deps, alertMessage({ code: codeOf(row), stage: next, attempts, error: msg, blocked: reportOf(row).blocked }));
      }
      return { outcome: "failed", row: (await getEpisode(deps.db, weekStart))! };
    }
  }
}
