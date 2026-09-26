import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createClient, type Database } from "@factions/db";
import { PgScreeningStore } from "../screening/store.js";
import type { StoredReport } from "../stages/run.js";
import { getEpisode } from "../stages/store.js";
import { parseWeekArg } from "../weeks.js";

/** Spec §7.4: an operator row wins over both automatic passes and is never overwritten by them. */
export async function setVerdict(db: Database, text: string, verdict: "allow" | "block"): Promise<void> {
  await new PgScreeningStore(db).put(text, { verdict, source: "operator", reason: "operator" });
}

/** ⚠️ Raw blocked text, for the operator's terminal. Never post this to Discord. */
export async function weekReport(db: Database, weekStart: Date): Promise<string> {
  const row = await getEpisode(db, weekStart);
  if (!row) return "no episode row for that week";
  const rep = (row.screeningReport ?? { redactions: [], blocked: [], allowed: [] }) as StoredReport;
  return [
    `stage: ${row.stage}${row.lastError ? ` (last error: ${row.lastError})` : ""}`,
    "redactions:",
    ...(rep.redactions.length ? rep.redactions.map((r) => `  ${r.text} -> ${r.replacement ?? "(dropped)"} (${r.source}: ${r.reason ?? ""})`) : ["  none"]),
    "script:",
    ...((rep.scriptReasons ?? []).length ? rep.scriptReasons!.map((s) => `  ${s}`) : ["  no failed attempts"]),
  ].join("\n");
}

// ⚠️ Under tsx, `import.meta.url` (a `file://` URL) and `process.argv[1]` (a bare path) differ
// in form; a plain string comparison is false even when this file IS the entry point, which
// would make the CLI silently print nothing when invoked for real. `pathToFileURL` normalizes
// both sides to the same URL form (task-11-brief's own note on this exact hazard).
const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const { values } = parseArgs({ options: { allow: { type: "string" }, block: { type: "string" }, show: { type: "string" } } });
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
  const chosen = [values.allow, values.block, values.show].filter((v) => v !== undefined).length;
  if (chosen !== 1) { console.error('usage: pnpm show:screening --allow "<text>" | --block "<text>" | --show <YYYY-MM-DD>'); process.exit(2); }
  const db = createClient(url);
  try {
    if (values.show) console.log(await weekReport(db, parseWeekArg(values.show)));
    else {
      await setVerdict(db, (values.allow ?? values.block)!, values.allow !== undefined ? "allow" : "block");
      console.log("saved. An episode already scripted keeps its old verdict until `pnpm run show --week <date> --force`.");
    }
  } finally {
    await db.$client.end();
  }
}
