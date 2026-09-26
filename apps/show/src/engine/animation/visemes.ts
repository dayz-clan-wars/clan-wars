import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnRun, type Run } from "../run.js";

// Ported from KOTH bot/src/animation/visemes.js at a5ef8e7, typed. `defaultRhubarbRun` now spawns
// through `Run`/`spawnRun` (the one child-process helper every ffmpeg/rhubarb call uses) instead of
// its own private `child_process.spawn` wrapper, and takes `rhubarbPath` as a required parameter —
// the KOTH fallback to `process.env.RHUBARB_PATH` is dropped so engine code reads no env.

// The fs subset defaultRhubarbRun needs for its temp dialog file — narrower than `audio/jingle.ts`'s
// `FsLike` (which also carries existsSync/readFileSync/mkdirSync this file never touches), so it is
// its own local type rather than a forced reuse.
export type FsWriteLike = { writeFileSync: (p: string, data: Buffer) => void; unlinkSync?: (p: string) => void };

const SHAPE_TO_LIP: Record<string, string> = {
  A: "Lip_A",
  B: "Lip_B",
  C: "Lip_C",
  D: "Lip_D",
  E: "Lip_E",
  F: "Lip_F",
  G: "Lip_G",
  H: "Lip_H",
  X: "Lip_X",
};

export type Cue = { startSec: number; endSec: number; mouth: string };

/** Rhubarb JSON string -> [{startSec,endSec,mouth}], mapping A-H/X to Lip_* (unknown -> Lip_X). */
export function parseRhubarbCues(jsonText: string): Cue[] {
  const data = JSON.parse(jsonText) as { mouthCues?: { start: number; end: number; value: string }[] };
  return (data.mouthCues ?? []).map((c) => ({
    startSec: c.start,
    endSec: c.end,
    mouth: SHAPE_TO_LIP[c.value] ?? "Lip_X",
  }));
}

export type RhubarbRun = (o: { audioPath: string; dialogText?: string }) => Promise<string>;

/** Run Rhubarb (injected) on one turn and parse its cues. */
export async function visemesForTurn(
  runRhubarb: RhubarbRun,
  o: { audioPath: string; dialogText?: string },
): Promise<Cue[]> {
  return parseRhubarbCues(await runRhubarb(o));
}

/**
 * Default runner: rhubarb -r phonetic -f json [-d dialog] <audio>; resolves stdout JSON.
 * `rhubarbPath` is required — the caller fills it from config (RenderConfig, Task 11); this file
 * reads no env var.
 */
export async function defaultRhubarbRun(o: {
  audioPath: string;
  dialogText?: string;
  rhubarbPath: string;
  fsImpl?: FsWriteLike;
  runImpl?: Run;
}): Promise<string> {
  const { audioPath, dialogText, rhubarbPath, fsImpl = fs, runImpl = spawnRun } = o;
  const args = ["-r", "phonetic", "-f", "json"];
  let dialogFile: string | null = null;
  if (dialogText) {
    dialogFile = path.join(os.tmpdir(), `rhubarb-${process.pid}-${audioPath.replace(/\W/g, "")}.txt`);
    fsImpl.writeFileSync(dialogFile, Buffer.from(dialogText));
    args.push("-d", dialogFile);
  }
  args.push(audioPath);
  try {
    const out = await runImpl(rhubarbPath, args);
    return out.toString("utf8");
  } finally {
    if (dialogFile) {
      try {
        fsImpl.unlinkSync?.(dialogFile);
      } catch {
        /* best-effort */
      }
    }
  }
}
