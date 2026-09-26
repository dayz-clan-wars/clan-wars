// Variant-layer ids taken verbatim from the delivered SVGs — including the artist's exact
// spellings/casing (Boris uses TitleCase + the misspelling "thougtful"; Pavel uses lowercase).
// Ported from KOTH bot/src/animation/rigManifest.js at a5ef8e7, typed.

export type RigManifest = {
  mouths: string[];
  eyes: { open: string[]; closed: string[] };
  pupils: string[];
  // Measured from the 1920-wide render (px): sclera half-width + each pupil's rest offset from its
  // sclera center (positive = toward that eye's right). Drives the convergence gaze in poseCharacter.
  eyeGeom: { halfWidth: number; pupilRest: Record<string, number> };
  brows: { neutral: string[]; raised: string[]; angry: string[]; thoughtful: string[] };
};

export const BORIS_RIG: RigManifest = {
  mouths: ["Lip_A", "Lip_B", "Lip_C", "Lip_D", "Lip_E", "Lip_F", "Lip_G", "Lip_H", "Lip_X", "Lip_Happy", "Lip_shad"],
  eyes: {
    open: ["Right_sclera", "Left_sclera", "Right_Pupil", "Left_Pupil"],
    closed: ["Right_Eye_closed", "Left_Eye_closed"],
  },
  pupils: ["Right_Pupil", "Left_Pupil"],
  eyeGeom: { halfWidth: 29, pupilRest: { Right_Pupil: -7.6, Left_Pupil: 7.7 } },
  brows: {
    neutral: ["Right_Eyebrow_Neutral", "Left_Eyebrow_neutral"],
    raised: ["Right_Eyebrow_raised", "Left_Eyebrow_raised"],
    angry: ["Right_Eyebrow_Angry", "Left_Eyebrow_Angry"],
    thoughtful: ["Right_Eyebrow_thougtful", "Left_Eyebrow_thougtful"],
  },
};

export const PAVEL_RIG: RigManifest = {
  mouths: ["Lip_A", "Lip_B", "Lip_C", "Lip_D", "Lip_E", "Lip_F", "Lip_G", "Lip_H", "Lip_X", "Lip_neutral"],
  eyes: {
    open: ["Right_sclera", "Left_sclera", "Right_pupil", "Left_pupil"],
    closed: ["Right_eye_closed", "Left_eye_closed"],
  },
  pupils: ["Right_pupil", "Left_pupil"],
  eyeGeom: { halfWidth: 21, pupilRest: { Right_pupil: -2.2, Left_pupil: 3.7 } },
  brows: {
    neutral: ["Right_eyebrow_neutral", "Left_eyebrow_neutral"],
    raised: ["Right_eyebrow_raised", "Left_eyebrow_raised"],
    angry: ["Right_eyebrow_angry", "Left_eyebrow_angry"],
    thoughtful: ["Right_eyebrow_thoughtful", "Left_eyebrow_thoughtful"],
  },
};

/** Every variant layer id across mouths, both eye states, and all four brow sets. */
export function allVariantIds(manifest: RigManifest): string[] {
  return [...manifest.mouths, ...manifest.eyes.open, ...manifest.eyes.closed, ...Object.values(manifest.brows).flat()];
}
