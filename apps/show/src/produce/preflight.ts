import fs from "node:fs";
import path from "node:path";
import type { RenderConfig } from "../config.js";
import { spawnRun, type Run } from "../engine/run.js";

/**
 * The cache dir for `--render <dir>`: SHOW_CACHE_DIR when it was set, else `<dir>/.cache`.
 * The `/var/lib/clan-wars-show` default belongs to the plan-3 service; a local render must not
 * need root on a Mac, and must not share (and prune) the scheduled pipeline's cache on the host.
 */
export function renderCacheDir(cfg: Pick<RenderConfig, "cacheDir" | "cacheDirSet">, renderDir: string): string {
  return cfg.cacheDirSet ? cfg.cacheDir : path.join(renderDir, ".cache");
}

/**
 * Fail fast, before any LLM call is paid for: create the cache dir, then check that ffmpeg
 * (`-version`) and Rhubarb (`--version`) both run. Each failure names what is missing.
 */
export async function preflightRender(
  cfg: { cacheDir: string; ffmpegPath: string; rhubarbPath: string },
  deps: { runImpl?: Run; fsImpl?: { mkdirSync: (p: string, o?: { recursive?: boolean }) => unknown } } = {},
): Promise<void> {
  const { runImpl = spawnRun, fsImpl = fs } = deps;
  try {
    fsImpl.mkdirSync(cfg.cacheDir, { recursive: true });
  } catch (err) {
    throw new Error(`--render: could not create the cache directory "${cfg.cacheDir}" (set SHOW_CACHE_DIR to a writable path): ${(err as Error).message}`);
  }
  const check = async (name: string, bin: string, flag: string, envKey: string) => {
    try {
      await runImpl(bin, [flag]);
    } catch (err) {
      throw new Error(`--render: ${name} could not be run as "${bin}" (install it or set ${envKey}): ${(err as Error).message}`);
    }
  };
  await check("ffmpeg", cfg.ffmpegPath, "-version", "FFMPEG_PATH");
  await check("Rhubarb", cfg.rhubarbPath, "--version", "RHUBARB_PATH");
}
