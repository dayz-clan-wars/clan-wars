import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { createClient } from "@factions/db";
import { loadConfig } from "./config.js";
import { episodeCode, lastEndedWeek, parseWeekArg } from "./weeks.js";
import { buildStoryContext } from "./story/context.js";
import { createChat } from "./engine/llm/openrouter.js";
import { createModerator } from "./screening/moderate.js";
import { MemoryScreeningStore } from "./screening/store.js";
import { screenTexts } from "./screening/screen.js";
import { redactContext } from "./screening/redact.js";
import { buildShowPrompt } from "./prompt/build.js";
import { writeScript } from "./script/write-script.js";

const { values } = parseArgs({
  options: {
    week: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "print-prompt": { type: "boolean", default: false },
  },
});

if (!values["dry-run"]) {
  console.error("Only --dry-run exists so far. The pipeline that voices, renders and publishes arrives with plan 3.");
  process.exit(2);
}

const cfg = loadConfig();
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
  // In memory: a dry run writes no verdicts anywhere. Operator overrides are not applied.
  const verdicts = await screenTexts(texts.entries().map((e) => e.text), { store: new MemoryScreeningStore(), moderate });
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
  });
  if (!result.ok) {
    section("HELD", result.reasons.join("\n"));
    process.exitCode = 1;
  } else {
    section(`SCRIPT: ${result.title} (${result.narrative.length} characters, attempt ${result.attempts})`, result.narrative);
    section("STORYLINES", JSON.stringify(result.storylines, null, 2));
  }
} finally {
  await db.$client.end();
}
