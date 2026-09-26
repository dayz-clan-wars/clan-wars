import { describe, it, expect } from "vitest";
import { poseKey } from "../../../src/engine/animation/compositor.js";

// buildComposeArgs and renderPoc (the proof-of-concept path) are dropped per the task-6 brief —
// nothing in the pipeline calls them — along with their KOTH tests. renderSegment/
// buildSegmentComposeArgs are ported in renderSegment.test.ts.
describe("poseKey", () => {
  it("is stable and distinguishes states", () => {
    expect(poseKey({ mouth: "Lip_A", eyes: "open", brows: "neutral", gaze: "center" })).toBe("Lip_A|open|neutral|center");
    expect(poseKey({ mouth: "Lip_A", eyes: "closed", brows: "neutral", gaze: "center" })).not.toBe(
      poseKey({ mouth: "Lip_A", eyes: "open", brows: "neutral", gaze: "center" }),
    );
    expect(poseKey({ mouth: "Lip_A", eyes: "open", brows: "neutral", gaze: "left" })).not.toBe(
      poseKey({ mouth: "Lip_A", eyes: "open", brows: "neutral", gaze: "right" }),
    );
  });
});
