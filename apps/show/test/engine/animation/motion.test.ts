import { describe, it, expect } from "vitest";
import { frameStates, type Turn } from "../../../src/engine/animation/motion.js";

const TURNS: Turn[] = [
  { speaker: "boris", startSec: 0, endSec: 1, visemes: [{ startSec: 0, endSec: 1, mouth: "Lip_D" }] },
  { speaker: "pavel", startSec: 1, endSec: 2, visemes: [{ startSec: 1, endSec: 2, mouth: "Lip_C" }] },
];

describe("frameStates", () => {
  it("is deterministic for a fixed seed", () => {
    const a = frameStates({ turns: TURNS, fps: 12, totalSec: 2, seed: 7 });
    const b = frameStates({ turns: TURNS, fps: 12, totalSec: 2, seed: 7 });
    expect(a).toEqual(b);
    expect(a).toHaveLength(24);
  });

  it("speaker mouths from visemes; listener rests at Lip_X", () => {
    const f = frameStates({ turns: TURNS, fps: 12, totalSec: 2, seed: 7 });
    expect(f[0]!.boris.mouth).toBe("Lip_D"); // boris speaking at t=0
    expect(f[0]!.pavel.mouth).toBe("Lip_X"); // pavel listening
    expect(f[18]!.pavel.mouth).toBe("Lip_C"); // pavel speaking at t=1.5
    expect(f[18]!.boris.mouth).toBe("Lip_X"); // boris listening
  });

  it("a turn-start frame raises the speaker brow", () => {
    const f = frameStates({ turns: TURNS, fps: 12, totalSec: 2, seed: 7 });
    expect(f[0]!.boris.brows).toBe("raised");
    expect(f[12]!.pavel.brows).toBe("raised"); // pavel's turn starts at t=1
  });

  it("listener pupils gaze toward the speaker; speaker looks center", () => {
    const f = frameStates({ turns: TURNS, fps: 12, totalSec: 2, seed: 7 });
    expect(f[0]!.boris.gaze).toBe("center"); // boris speaking at t=0
    expect(f[0]!.pavel.gaze).toBe("left"); // pavel listening, looks toward boris (left)
    expect(f[18]!.pavel.gaze).toBe("center"); // pavel speaking at t=1.5
    expect(f[18]!.boris.gaze).toBe("right"); // boris listening, looks toward pavel (right)
  });

  it("eyes are open or closed only", () => {
    const f = frameStates({ turns: TURNS, fps: 12, totalSec: 2, seed: 7 });
    for (const fr of f) {
      expect(["open", "closed"]).toContain(fr.boris.eyes);
      expect(["open", "closed"]).toContain(fr.pavel.eyes);
    }
  });
});
