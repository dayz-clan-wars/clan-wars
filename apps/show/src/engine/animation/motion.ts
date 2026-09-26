import type { FramePose } from "./rig.js";

// Ported from KOTH bot/src/animation/motion.js at a5ef8e7, typed.

const REST = "Lip_X";
const BROW_ACCENT_SEC = 0.3; // raised brow for the first 0.3s of a host's own turn
const BLINK_SEC = 0.15; // eyes closed duration
const BLINK_MIN = 3,
  BLINK_MAX = 5; // seconds between blinks

export type Viseme = { startSec: number; endSec: number; mouth: string };
export type Turn = { speaker: "boris" | "pavel"; startSec: number; endSec: number; visemes: Viseme[] };

/** Deterministic 32-bit PRNG (mulberry32) so blink schedules are stable + no Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Precompute [start,end] blink windows across totalSec for one host. */
function blinkWindows(seed: number, totalSec: number): [number, number][] {
  const rnd = mulberry32(seed);
  const windows: [number, number][] = [];
  let t = BLINK_MIN + rnd() * (BLINK_MAX - BLINK_MIN);
  while (t < totalSec) {
    windows.push([t, t + BLINK_SEC]);
    t += BLINK_SEC + BLINK_MIN + rnd() * (BLINK_MAX - BLINK_MIN);
  }
  return windows;
}

const inWindow = (windows: [number, number][], t: number) => windows.some(([s, e]) => t >= s && t < e);

function turnAt(turns: Turn[], t: number): Turn {
  return turns.find((tn) => t >= tn.startSec && t < tn.endSec) ?? turns[turns.length - 1]!;
}
function mouthAt(turn: Turn, t: number): string {
  return (turn.visemes.find((v) => t >= v.startSec && t < v.endSec) ?? { mouth: REST }).mouth;
}

/** Per-frame poses for both hosts across the segment, deterministic for a fixed seed. */
export function frameStates(o: {
  turns: Turn[];
  fps: number;
  totalSec: number;
  seed?: number;
}): { boris: FramePose; pavel: FramePose }[] {
  const { turns, fps, totalSec, seed = 1 } = o;
  // Distinct blink seeds per host so they don't blink in lockstep.
  const blinks = { boris: blinkWindows(seed + 101, totalSec), pavel: blinkWindows(seed + 202, totalSec) };
  const n = Math.round(totalSec * fps);
  const frames: { boris: FramePose; pavel: FramePose }[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const turn = turnAt(turns, t);
    const host = (name: "boris" | "pavel"): FramePose => {
      const speaking = turn.speaker === name;
      const ownTurn = turns.find((tn) => tn.speaker === name && t >= tn.startSec && t < tn.endSec);
      const raised = !!ownTurn && t - ownTurn.startSec < BROW_ACCENT_SEC;
      const gaze = speaking ? "center" : name === "boris" ? "right" : "left";
      return {
        mouth: speaking ? mouthAt(turn, t) : REST,
        eyes: inWindow(blinks[name], t) ? "closed" : "open",
        brows: raised ? "raised" : "neutral",
        gaze,
      };
    };
    frames.push({ boris: host("boris"), pavel: host("pavel") });
  }
  return frames;
}
