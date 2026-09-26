import { describe, it, expect } from "vitest";
import { parseRhubarbCues, visemesForTurn } from "../../../src/engine/animation/visemes.js";

const SAMPLE = JSON.stringify({
  metadata: { soundFile: "t.wav", duration: 0.3 },
  mouthCues: [
    { start: 0.0, end: 0.11, value: "B" },
    { start: 0.11, end: 0.19, value: "F" },
    { start: 0.19, end: 0.3, value: "X" },
  ],
});

describe("visemes", () => {
  it("parseRhubarbCues maps shapes to Lip_* ids", () => {
    expect(parseRhubarbCues(SAMPLE)).toEqual([
      { startSec: 0.0, endSec: 0.11, mouth: "Lip_B" },
      { startSec: 0.11, endSec: 0.19, mouth: "Lip_F" },
      { startSec: 0.19, endSec: 0.3, mouth: "Lip_X" },
    ]);
  });

  it("unknown shape falls back to Lip_X", () => {
    expect(parseRhubarbCues(JSON.stringify({ mouthCues: [{ start: 0, end: 1, value: "?" }] }))).toEqual([
      { startSec: 0, endSec: 1, mouth: "Lip_X" },
    ]);
  });

  it("visemesForTurn runs the injected runner and parses its output", async () => {
    const runRhubarb = async ({ audioPath, dialogText }: { audioPath: string; dialogText?: string }) => {
      expect(audioPath).toBe("/tmp/t.wav");
      expect(dialogText).toBe("hello");
      return SAMPLE;
    };
    const cues = await visemesForTurn(runRhubarb, { audioPath: "/tmp/t.wav", dialogText: "hello" });
    expect(cues[0]).toEqual({ startSec: 0, endSec: 0.11, mouth: "Lip_B" });
  });
});
