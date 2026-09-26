import { describe, it, expect } from "vitest";
import { buildSegmentTimeline, type SynthesizedTurn } from "../../../src/engine/animation/visemeTimeline.js";
import type { Run } from "../../../src/engine/run.js";

describe("buildSegmentTimeline", () => {
  it("builds a speaker-tagged, offset viseme timeline per turn", async () => {
    const SR = 24000;
    // two 0.5s turns back-to-back (0.1s gap between). segmentPcm length is not sliced by the fake.
    const turns: SynthesizedTurn[] = [
      { startSec: 0, endSec: 0.5, voiceId: "B" },
      { startSec: 0.6, endSec: 1.1, voiceId: "P" },
    ];
    const segmentPcm = Buffer.alloc(Math.round(1.1 * SR * 2));
    const writes: { p: string; len: number }[] = [];
    const fsImpl = { writeFileSync: (p: string, d: Buffer) => writes.push({ p, len: d.length }) };
    const runFfmpeg: Run = async () => Buffer.alloc(0); // pcm->wav, no-op in test
    // fake Rhubarb: always one cue [0,0.2] mouth Lip_A, relative to the turn.
    const runRhubarb = async () => JSON.stringify({ mouthCues: [{ start: 0, end: 0.2, value: "A" }] });

    const tl = await buildSegmentTimeline(
      { runRhubarb, runFfmpeg, fsImpl },
      { segmentPcm, turns, borisVoiceId: "B", workDir: "/tmp/x" },
    );

    expect(tl).toHaveLength(2);
    expect(tl[0]!.speaker).toBe("boris");
    expect(tl[1]!.speaker).toBe("pavel");
    // turn 0 viseme unshifted; turn 1 shifted by its startSec (0.6).
    expect(tl[0]!.visemes[0]).toEqual({ startSec: 0, endSec: 0.2, mouth: "Lip_A" });
    expect(tl[1]!.visemes[0]!.startSec).toBeCloseTo(0.6, 3);
    expect(tl[1]!.startSec).toBeCloseTo(0.6, 3);
    void writes;
  });
});
