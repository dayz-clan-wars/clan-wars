import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import type { PronunciationStore } from "../engine/audio/pronunciationStore.js";
import type { Verdict } from "../screening/store.js";
import { rows } from "../story/sql.js";

export const BACKFILL_CHUNK = 50;

export async function knownNames(db: Database): Promise<string[]> {
  const rs = await rows<{ t: string }>(db, sql`
    select gamertag as t from players union select name from factions union select tag from factions order by 1`);
  return rs.map((r) => r.t).filter((t) => t.trim() !== "");
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * `pnpm show:backfill-pronunciations` (spec §10): freeze a spoken form for every known name
 * before an episode needs it. ⚠️ Screened first, in chunks: spec §7.3 never sends a blocked
 * name to the pronunciation pass, and a backfill must not be the way one gets there.
 */
export async function backfillPronunciations(o: {
  names: string[]; screen: (t: string[]) => Promise<Map<string, Verdict>>; store: PronunciationStore;
  overrides: Record<string, string>; pronounce: (names: string[]) => Promise<void>; dryRun: boolean;
}) {
  const names = [...new Set(o.names)];
  const allowed: string[] = [];
  for (const c of chunks(names, BACKFILL_CHUNK)) {
    const v = await o.screen(c);
    for (const t of c) if (v.get(t)?.verdict === "allow") allowed.push(t);
  }
  const overridden = allowed.filter((t) => t in o.overrides);
  const cachedMap = await o.store.get(allowed);
  const cached = allowed.filter((t) => !(t in o.overrides) && t in cachedMap);
  const toGenerate = allowed.filter((t) => !(t in o.overrides) && !(t in cachedMap));
  let generated = 0;
  if (!o.dryRun) {
    for (const c of chunks(toGenerate, BACKFILL_CHUNK)) await o.pronounce(c);
    generated = Object.keys(await o.store.get(toGenerate)).length;
  }
  return { total: names.length, blocked: names.length - allowed.length, overridden: overridden.length, cached: cached.length, toGenerate, generated };
}
