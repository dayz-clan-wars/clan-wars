import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { createClient } from "@factions/db";
import { loadConfig, loadRenderConfig } from "./config.js";
import { episodeCode, lastEndedWeek, parseWeekArg } from "./weeks.js";
import { buildStoryContext } from "./story/context.js";
import { createChat } from "./engine/llm/openrouter.js";
import { createModerator } from "./screening/moderate.js";
import { MemoryScreeningStore, PgScreeningStore, ReadThroughScreeningStore } from "./screening/store.js";
import { screenTexts } from "./screening/screen.js";
import { redactContext } from "./screening/redact.js";
import { buildShowPrompt } from "./prompt/build.js";
import { writeScript } from "./script/write-script.js";
import { PgPronunciationStore, ReadThroughPronunciationStore } from "./stores/pronunciations.js";
import { MemoryPronunciationStore } from "./engine/audio/pronunciationStore.js";
import type { Run } from "./engine/run.js";
import { spawnRun } from "./engine/run.js";
import { voiceEpisode } from "./produce/voice.js";
import { renderEpisode } from "./produce/render.js";

const { values } = parseArgs({
  options: {
    week: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "print-prompt": { type: "boolean", default: false },
    render: { type: "string" },
  },
});

const renderDir = values.render;
if (!values["dry-run"] && !renderDir) {
  console.error("Neither --dry-run nor --render <dir> was given. The scheduled pipeline arrives with plan 3.");
  process.exit(2);
}

const cfg = loadConfig();
// Only loaded (and thus only required) when actually rendering, so a dry run needs no
// ElevenLabs key or binaries (Task 11 brief).
const renderCfg = renderDir ? loadRenderConfig() : null;
// `ffmpegPath` must reach every ffmpeg spawn; every other command (the rhubarb path,
// via VoiceDeps.rhubarbPath) passes through unchanged (task-10-report.md).
const runImpl: Run | undefined = renderCfg
  ? (cmd, args, opts) => spawnRun(cmd === "ffmpeg" ? renderCfg.ffmpegPath : cmd, args, opts)
  : undefined;
// ⚠️ Read-only at the connection level: a dry run may be pointed at factions_live, and
// CLAUDE.md allows nothing there but a migration or a read-only check.
const db = createClient(cfg.databaseUrl, { readOnly: true });
const section = (title: string, body: string) => console.log(`\n===== ${title} =====\n${body}`);

try {
  const weekStart = values.week ? parseWeekArg(values.week) : lastEndedWeek(new Date());
  // The show's migration may not have reached this database yet.
  const [probe] = (await db.execute(sql`select to_regclass('public.show_episodes') is not null as ok`)) as unknown as { ok: boolean }[];
  const { context, texts } = await buildStoryContext(db, { weekStart, staffTags: cfg.staffTags, previous: probe?.ok ? "db" : null });

  const chat = createChat({ apiKey: cfg.openrouterApiKey });
  const moderate = createModerator({ chat, model: cfg.moderationModel });
  // A dry run writes no verdicts anywhere. It reads the real ones (operator overrides
  // included) when the show's tables exist; reads are legal on the read-only connection.
  const store = probe?.ok ? new ReadThroughScreeningStore(new PgScreeningStore(db)) : new MemoryScreeningStore();
  const verdicts = await screenTexts(texts.entries().map((e) => e.text), { store, moderate });
  const allowed = [...verdicts].filter(([, v]) => v.verdict === "allow" && v.source === "operator").map(([t]) => t);
  const { context: screened, report, blocked } = redactContext(context, texts.entries(), verdicts);

  section(`${episodeCode(context.week.season, context.week.episode)} · week of ${weekStart.toISOString().slice(0, 10)}`, `${texts.entries().length} player strings screened, ${report.redactions.length} redacted`);
  if (report.redactions.length > 0) section("REDACTIONS", JSON.stringify(report.redactions, null, 2));
  section("CONTEXT", JSON.stringify(screened, null, 2));
  if (values["print-prompt"]) {
    const { system, user } = buildShowPrompt(screened);
    section("SYSTEM PROMPT", system);
    section("USER MESSAGE", user);
  }

  const result = await writeScript(screened, blocked, {
    generate: (system, user) => chat({ model: cfg.scriptModel, temperature: 0.9, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    moderate,
    allowed,
  });
  if (!result.ok) {
    section("HELD", result.reasons.join("\n"));
    process.exitCode = 1;
  } else {
    if (result.reasons.length > 0) section("EARLIER ATTEMPTS", result.reasons.join("\n"));
    section(`SCRIPT: ${result.title} (${result.narrative.length} characters, attempt ${result.attempts})`, result.narrative);
    section("STORYLINES", JSON.stringify(result.storylines, null, 2));

    if (renderCfg) {
      // Same read-through pattern as the screening store above: Postgres read when
      // show_pronunciations exists, memory write. Never writes to the read side, so it
      // stays safe on the read-only connection (global constraints).
      const pronunciationStore = probe?.ok
        ? new ReadThroughPronunciationStore(new PgPronunciationStore(db), new MemoryPronunciationStore())
        : new MemoryPronunciationStore();

      fs.mkdirSync(renderCfg.cacheDir, { recursive: true });

      const voiced = await voiceEpisode(
        {
          chat,
          pronunciationModel: renderCfg.pronunciationModel,
          store: pronunciationStore,
          overrides: renderCfg.pronunciationOverrides,
          elevenApiKey: renderCfg.elevenApiKey,
          elevenModel: renderCfg.elevenModel,
          borisVoiceId: renderCfg.borisVoiceId,
          pavelVoiceId: renderCfg.pavelVoiceId,
          cacheDir: renderCfg.cacheDir,
          rhubarbPath: renderCfg.rhubarbPath,
          runImpl,
        },
        { weekStart: weekStart.toISOString(), narrative: result.narrative, context: screened },
      );
      const videoPath = await renderEpisode(
        { cacheDir: renderCfg.cacheDir, discordInvite: renderCfg.discordInvite, runImpl },
        { voiced, context: screened },
      );

      fs.mkdirSync(renderDir!, { recursive: true });
      const outMp3 = path.join(renderDir!, "episode.mp3");
      const outMp4 = path.join(renderDir!, "video.mp4");
      fs.copyFileSync(voiced.mp3Path, outMp3);
      fs.copyFileSync(videoPath, outMp4);
      section("RENDERED", `${outMp3}\n${outMp4}\nduration: ${voiced.totalSec.toFixed(1)}s`);
    }
  }
} finally {
  await db.$client.end();
}
