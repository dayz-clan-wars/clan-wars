import fs from "node:fs";
import path from "node:path";
import { jingleCachePath, cachedPcm, type FsLike } from "./jingle.js";

/**
 * Load a cached jingle/outro segment PCM, or build + persist it. Best-effort: a missing source
 * file returns null (segment omitted); a build/cache failure logs and returns null so the rest of
 * the episode is unaffected. The cache lives in `.jingle-cache/` next to the source file.
 *
 * Ported from KOTH `episode.js`'s `loadOrBuildSegment`; the `serverName` parameter is dropped
 * (this app serves one show, not a fleet of Discord servers) and the log prefix becomes `[show]`.
 */
export async function loadOrBuildSegment(o: {
  srcPath: string | null | undefined;
  fsImpl?: FsLike;
  key: string | null;
  kind: string;
  build: () => Promise<Buffer>;
}): Promise<Buffer | null> {
  const { srcPath, fsImpl = fs, key, kind, build } = o;
  if (!srcPath || !fsImpl.existsSync(srcPath)) return null;
  try {
    const cacheDir = path.join(path.dirname(srcPath), ".jingle-cache");
    fsImpl.mkdirSync(cacheDir, { recursive: true });
    return await cachedPcm({ file: jingleCachePath({ cacheDir, key: key ?? "", kind }), fsImpl, build });
  } catch (e) {
    console.error(`[show] jingle ${kind} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
