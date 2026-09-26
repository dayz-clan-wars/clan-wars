import { describe, it, expect } from "vitest";
import { poseCharacter } from "../../../src/engine/animation/rig.js";
import type { RigManifest } from "../../../src/engine/animation/rigManifest.js";

const MANIFEST: RigManifest = {
  mouths: ["Lip_A", "Lip_B", "Lip_X"],
  eyes: { open: ["Right_sclera", "Right_Pupil", "Left_Pupil"], closed: ["Right_Eye_closed"] },
  brows: { neutral: ["Brow_N"], raised: ["Brow_R"], angry: ["Brow_A"], thoughtful: ["Brow_T"] },
  pupils: ["Right_Pupil", "Left_Pupil"],
  eyeGeom: { halfWidth: 20, pupilRest: { Right_Pupil: -4, Left_Pupil: 4 } },
};
const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
  '<g id="Body"><rect/></g>',
  '<g id="Lip_A"/><g id="Lip_B"/><g id="Lip_X"/>',
  '<g id="Right_sclera"/><g id="Right_Pupil"/><g id="Left_Pupil"/><g id="Right_Eye_closed"/>',
  '<g id="Brow_N"/><g id="Brow_R"/><g id="Brow_A"/><g id="Brow_T"/>',
  "</svg>",
].join("");

const hidden = (svg: string, id: string) => new RegExp(`<g id="${id}" display="none"`).test(svg);
// Extract the horizontal pupil shift injected for a given layer id (null if none).
const dxOf = (svg: string, id: string): number | null => {
  const m = svg.match(new RegExp(`<g id="${id}" transform="translate\\((-?\\d+),0\\)"`));
  return m ? Number(m[1]) : null;
};

describe("poseCharacter", () => {
  it("keeps the selected mouth, hides the others", () => {
    const out = poseCharacter(SVG, MANIFEST, { mouth: "Lip_A", eyes: "open", brows: "neutral" });
    expect(hidden(out, "Lip_A")).toBe(false);
    expect(hidden(out, "Lip_B")).toBe(true);
    expect(hidden(out, "Lip_X")).toBe(true);
  });

  it("open eyes hide the closed lid, keep sclera+pupil", () => {
    const out = poseCharacter(SVG, MANIFEST, { mouth: "Lip_X", eyes: "open", brows: "neutral" });
    expect(hidden(out, "Right_Eye_closed")).toBe(true);
    expect(hidden(out, "Right_sclera")).toBe(false);
    expect(hidden(out, "Right_Pupil")).toBe(false);
  });

  it("closed eyes hide sclera+pupil, keep the closed lid", () => {
    const out = poseCharacter(SVG, MANIFEST, { mouth: "Lip_X", eyes: "closed", brows: "neutral" });
    expect(hidden(out, "Right_sclera")).toBe(true);
    expect(hidden(out, "Right_Pupil")).toBe(true);
    expect(hidden(out, "Right_Eye_closed")).toBe(false);
  });

  it("only the selected brow set survives; body untouched", () => {
    const out = poseCharacter(SVG, MANIFEST, { mouth: "Lip_X", eyes: "open", brows: "raised" });
    expect(hidden(out, "Brow_R")).toBe(false);
    expect(hidden(out, "Brow_N")).toBe(true);
    expect(hidden(out, "Brow_A")).toBe(true);
    expect(out).toContain('<g id="Body"><rect/></g>');
  });

  it("gaze right: near (right) eye turns toward speaker and leads the far (left) eye", () => {
    const out = poseCharacter(SVG, MANIFEST, { mouth: "Lip_X", eyes: "open", brows: "neutral", gaze: "right" });
    const near = dxOf(out, "Right_Pupil"); // right eye is nearer when looking right
    const far = dxOf(out, "Left_Pupil");
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(near).toBeGreaterThan(0); // near eye turns rightward, toward the speaker
    expect(far).toBeGreaterThan(0); // far eye also moves toward the speaker (not backward)
    expect(Math.abs(near!)).toBeGreaterThan(Math.abs(far!)); // convergence: near eye leads far eye
  });

  it("gaze left: near (left) eye turns toward speaker and leads the far (right) eye", () => {
    const out = poseCharacter(SVG, MANIFEST, { mouth: "Lip_X", eyes: "open", brows: "neutral", gaze: "left" });
    const near = dxOf(out, "Left_Pupil"); // left eye is nearer when looking left
    const far = dxOf(out, "Right_Pupil");
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(near).toBeLessThan(0); // near eye turns leftward, toward the speaker
    expect(far).toBeLessThan(0); // far eye also moves toward the speaker (not backward)
    expect(Math.abs(near!)).toBeGreaterThan(Math.abs(far!)); // convergence: near eye leads far eye
  });

  it("gaze center (or omitted) leaves pupils untransformed", () => {
    const out = poseCharacter(SVG, MANIFEST, { mouth: "Lip_X", eyes: "open", brows: "neutral", gaze: "center" });
    expect(out).not.toContain('transform="translate(');
    const out2 = poseCharacter(SVG, MANIFEST, { mouth: "Lip_X", eyes: "open", brows: "neutral" });
    expect(out2).not.toContain('transform="translate(');
  });

  it("gaze right with closed eyes does not transform (pupils hidden anyway)", () => {
    const out = poseCharacter(SVG, MANIFEST, { mouth: "Lip_X", eyes: "closed", brows: "neutral", gaze: "right" });
    expect(out).not.toContain('transform="translate(');
  });
});
