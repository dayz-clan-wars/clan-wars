import fs from "node:fs";
import path from "node:path";
import { acquireAdvisoryLock, createClient, type Database } from "@factions/db";
import { loadServiceConfig, SHOW_LOCK_KEY } from "../config.js";
import { realDeps } from "../service.js";
import { loadSpecial } from "./load.js";
import { publishSpecial } from "./publish.js";

/**
 * `--special <dir> --publish <out>`: run on the host, where the YouTube, Discord and Facebook
 * credentials are. `<out>` holds the reviewed `video.mp4` and `episode.mp3` copied up from the
 * local render (a re-render would voice a different take than the one approved locally) and
 * `publish-state.json`. Run it again after the ✅. Returns the exit code.
 */
export async function runSpecialPublish(o: { dir: string; out: string }, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const special = loadSpecial(o.dir);
  const out = { videoPath: path.join(o.out, "video.mp4"), mp3Path: path.join(o.out, "episode.mp3"), statePath: path.join(o.out, "publish-state.json"), cutPath: path.join(o.out, "cut.txt") };
  for (const p of [out.videoPath, out.mp3Path, out.cutPath]) if (!fs.existsSync(p)) { console.error(`missing ${p}: copy the reviewed render here first`); return 2; }
  const cfg = loadServiceConfig(env);
  if (!cfg.enabled) { console.error("SHOW_ENABLED is off; a special publishes with the weekly show's credentials"); return 2; }
  // ⚠️ The timer's lock: a special publish and a weekly run never post at the same time.
  const lock = await acquireAdvisoryLock(cfg.databaseUrl, SHOW_LOCK_KEY);
  if (!lock) { console.error("a show run holds the lock; try again in a minute"); return 1; }
  let db: Database | undefined;
  try {
    db = createClient(cfg.databaseUrl);
    const outcome = await publishSpecial(realDeps(db, cfg), special, out);
    if (outcome === "cut-mismatch") {
      console.error("the script does not match the rendered cut (cut.txt) or the cut this dir already published; render again and use a new --publish dir");
      return 2;
    }
    console.log(`special ${special.slug}: ${outcome}`);
    return 0;
  } catch (e) {
    console.error(`special ${special.slug}: failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    try { await lock.release(); } finally { if (db) await db.$client.end(); }
  }
}
