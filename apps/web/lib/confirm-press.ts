/** Where a two-press button is: waiting, armed for the second press, or posted. */
export type ConfirmPhase = "idle" | "armed" | "pending";

/**
 * What one press does. `submit: false` means the click's default action (the
 * form submit) must be prevented.
 *
 * ⚠️ The armed press submits but stays "armed": the phase becomes "pending"
 * only when the form's `submit` event actually fires (guardFormSubmit). If the
 * browser's own validation stops the post — a required field left empty —
 * the button must not be stranded in "pending" with nothing sent.
 */
export function confirmPress(phase: ConfirmPhase): { next: ConfirmPhase; submit: boolean } {
  if (phase === "idle") return { next: "armed", submit: false };
  if (phase === "armed") return { next: "armed", submit: true };
  return { next: "pending", submit: false };
}

/** Looking away disarms; it never un-sends a post already in flight. */
export const confirmBlur = (phase: ConfirmPhase): ConfirmPhase => (phase === "pending" ? "pending" : "idle");
/** The arm window ran out. */
export const confirmExpire = (phase: ConfirmPhase): ConfirmPhase => (phase === "armed" ? "idle" : phase);
