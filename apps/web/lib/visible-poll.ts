/** The two things a poll reads from `document`: whether it is hidden, and the event that says it changed. */
export type PollDoc = EventTarget & { readonly hidden: boolean };

/**
 * Run `run` every `ms` while the page is visible (L9).
 *
 * ⚠️ /link and /kit poll every 5 s while a sequence is open, and a player
 * performing it is IN GAME, so that tab is almost always in the background.
 * Each poll is a database read for nobody. This stops while hidden and runs
 * once immediately on return, so a confirmation that landed while they were
 * away shows the moment they look.
 */
export function visiblePoll(doc: PollDoc, run: () => void, ms: number): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  const start = () => { if (id === null) id = setInterval(run, ms); };
  const stop = () => { if (id !== null) { clearInterval(id); id = null; } };
  const onChange = () => {
    if (doc.hidden) { stop(); return; }
    run();
    start();
  };
  if (!doc.hidden) start();
  doc.addEventListener("visibilitychange", onChange);
  return () => { stop(); doc.removeEventListener("visibilitychange", onChange); };
}
