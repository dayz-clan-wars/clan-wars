/** How long the kit's Undo bar stays (M9). WCAG 2.2.1 asks for time enough; 4.5 s was not. */
export const UNDO_MS = 10_000;

/** ⚠️ Two independent reasons a bar can be held — see the comment on `held` below. */
export type HoldReason = "pointer" | "focus";

export type DismissTimer = {
  start(): void;
  hold(reason: HoldReason): void;
  release(reason: HoldReason): void;
  cancel(): void;
};

/**
 * A countdown that pauses while it is held.
 *
 * ⚠️ `hold` while the pointer or focus is on the bar, `release` when it
 * leaves: releasing restarts the FULL time, because a player who moved to the
 * Undo and away again is not two thirds done deciding.
 */
export function dismissTimer(ms: number, onExpire: () => void): DismissTimer {
  let id: ReturnType<typeof setTimeout> | null = null;
  /**
   * ⚠️ Pointer and focus are tracked separately, not as one boolean.
   * `onMouseLeave` fires while keyboard focus is still on the bar's Undo
   * button (a mouse graze past it, or a tab-then-click), and releasing the
   * whole hold on that alone would run the countdown out from under a
   * focused control. The clock only resumes once BOTH are gone.
   */
  const held = new Set<HoldReason>();
  const stop = () => { if (id !== null) clearTimeout(id); id = null; };
  const start = () => {
    stop();
    if (held.size === 0) id = setTimeout(() => { id = null; onExpire(); }, ms);
  };
  return {
    start,
    hold: (reason) => { held.add(reason); stop(); },
    release: (reason) => { held.delete(reason); if (held.size === 0) start(); },
    /**
     * ⚠️ Clears every hold WITHOUT starting the countdown — the release path
     * for a bar that unmounted while still held (a refusal replaces the
     * toast before `onMouseLeave`/`onBlur` ever fire). Restarting here would
     * fire `onExpire` against a toast that is already gone; the point is
     * only to stop a stale hold from blocking every later `start()`.
     */
    cancel: () => { held.clear(); stop(); },
  };
}
