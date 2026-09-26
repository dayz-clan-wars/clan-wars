import { parseArgs } from "node:util";
import { createClient } from "@factions/db";
import { loadConfig, loadRenderConfig } from "../config.js";
import { resolveCachedPronouncer } from "../engine/audio/pronounceCached.js";
import { createChat } from "../engine/llm/openrouter.js";
import { createModerator } from "../screening/moderate.js";
import { screenTexts } from "../screening/screen.js";
import { PgScreeningStore } from "../screening/store.js";
import { PgPronunciationStore } from "../stores/pronunciations.js";
import { backfillPronunciations, knownNames } from "./backfill.js";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const cfg = loadConfig();
const render = loadRenderConfig();
const db = createClient(cfg.databaseUrl);
try {
  const chat = createChat({ apiKey: cfg.openrouterApiKey });
  const moderate = createModerator({ chat, model: cfg.moderationModel });
  const screeningStore = new PgScreeningStore(db);
  const store = new PgPronunciationStore(db);
  const r = await backfillPronunciations({
    names: await knownNames(db), store, overrides: render.pronunciationOverrides, dryRun: values["dry-run"],
    screen: (t) => screenTexts(t, { store: screeningStore, moderate }),
    pronounce: async (names) => { await resolveCachedPronouncer({ store, names, overrides: render.pronunciationOverrides, chat, model: render.pronunciationModel }); },
  });
  console.log(`${values["dry-run"] ? "[dry-run] " : ""}names: ${r.total}, blocked: ${r.blocked}, overridden: ${r.overridden}, cached: ${r.cached}, to generate: ${r.toGenerate.length}, generated: ${r.generated}`);
  if (!values["dry-run"] && r.generated < r.toGenerate.length) console.warn(`${r.toGenerate.length - r.generated} were not generated (LLM failure?); run it again`);
} finally {
  await db.$client.end();
}
