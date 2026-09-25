/** How long the kit's Undo bar stays (M9). WCAG 2.2.1 asks for time enough; 4.5 s was not. */
export const UNDO_MS = 10_000;

export type DismissTimer = { start(): void; hold(): void; release(): void; cancel(): void };

/**
 * A countdown that pauses while it is held.
 *
 * ⚠️ `hold` while the pointer or focus is on the bar, `release` when it
 * leaves: releasing restarts the FULL time, because a player who moved to the
 * Undo and away again is not two thirds done deciding.
 */
export function dismissTimer(ms: number, onExpire: () => void): DismissTimer {
  let id: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  const stop = () => { if (id !== null) clearTimeout(id); id = null; };
  const start = () => {
    stop();
    if (!held) id = setTimeout(() => { id = null; onExpire(); }, ms);
  };
  return {
    start,
    hold: () => { held = true; stop(); },
    release: () => { held = false; start(); },
    cancel: () => { held = false; stop(); },
  };
}
