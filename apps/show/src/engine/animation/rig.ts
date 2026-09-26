import { allVariantIds, type RigManifest } from "./rigManifest.js";

// Convergence gaze: while listening, the pupils turn toward the speaker. The rig's pupils rest
// off-center (toward the nose), so a uniform translate reads cross-eyed. Hybrid model, per eye:
//   NEAR eye (closer to the speaker) -> an absolute target offset from its OWN eye center (compensating
//     its noseward rest), so it clearly leads;
//   FAR  eye -> a small shift FROM its rest toward the speaker, so it always moves the right way and never
//     backward (its noseward rest already points speaker-ward, so a big absolute target would move it back).
// Amounts derive from the rig's measured eyeGeom (sclera half-width + each pupil's rest offset).
const GAZE_NEAR_FRAC = 0.6; // near-eye target from its eye center, as a fraction of eye radius
const GAZE_FAR_FRAC = 0.15; // far-eye shift from its rest toward the speaker, as a fraction of eye radius

/** One frame's expression for a single host: the chosen mouth, eye state, brow set and gaze. */
export type FramePose = { mouth: string; eyes: string; brows: string; gaze: string };

// poseCharacter's own input: gaze is optional here (defaults to 'center'), unlike FramePose (the
// frameStates() output, which always sets it) — KOTH's poseCharacter is called both ways.
type PoseInput = Omit<FramePose, "gaze"> & { gaze?: string };

/**
 * Return the character SVG posed to a single expression: the chosen mouth, eye state, and brow set
 * stay visible; every other variant layer gets display="none". Body/head/nose/eyeshad (anything not
 * in the manifest's variant lists) is left untouched. When gaze is 'left'/'right' and eyes are open,
 * each pupil is translated toward the speaker via the convergence model (near eye leads the far eye,
 * each relative to its own eye center) using `manifest.eyeGeom`.
 */
export function poseCharacter(svgText: string, manifest: RigManifest, pose: PoseInput): string {
  const { mouth, eyes, brows, gaze = "center" } = pose;
  const keep = new Set([mouth, ...manifest.eyes[eyes as "open" | "closed"], ...manifest.brows[brows as keyof RigManifest["brows"]]]);
  let out = svgText;
  for (const id of allVariantIds(manifest)) {
    if (keep.has(id)) continue;
    out = out.replace(new RegExp(`(<[a-zA-Z][^>]*\\sid="${id}")`), '$1 display="none"');
  }
  if (gaze !== "center" && eyes === "open" && manifest.eyeGeom) {
    const dir = gaze === "right" ? 1 : -1;
    const { halfWidth, pupilRest } = manifest.eyeGeom;
    for (const id of manifest.pupils) {
      const isNear = /right/i.test(id) ? dir > 0 : dir < 0;
      const dx = isNear
        ? Math.round(dir * GAZE_NEAR_FRAC * halfWidth - pupilRest[id]!) // absolute target from eye center
        : Math.round(dir * GAZE_FAR_FRAC * halfWidth); // shift from rest, always speaker-ward
      out = out.replace(new RegExp(`(<[a-zA-Z][^>]*\\sid="${id}")`), `$1 transform="translate(${dx},0)"`);
    }
  }
  return out;
}
