/**
 * The map's loading states, and when to ask again. Pure, so the one thing a
 * player sees on a bad connection is decided in one tested place.
 */
export type LoadError = "unauthenticated" | "not-linked" | "failed";
export type LoadView = "loading" | "failed-first" | "stale" | "ready" | "terminal";

/**
 * ⚠️ "stale" needs a map to be stale. The map is only created once the first
 * answer arrives AND Leaflet's chunk has loaded, so until then a failure
 * (of either) is "failed-first": "could not load" plus a retry, over nothing.
 * It used to be "What you see may be out of date" over a black screen.
 */
export function loadView(s: { mapReady: boolean; error: LoadError | null; leafletFailed: boolean }): LoadView {
  if (s.error === "unauthenticated" || s.error === "not-linked") return "terminal";
  if (!s.mapReady) return s.error === "failed" || s.leafletFailed ? "failed-first" : "loading";
  return s.error === "failed" ? "stale" : "ready";
}

/** After one failure, then two. Past the last step the ordinary poll takes over. */
export const RETRY_STEPS_MS = [15_000, 60_000] as const;

/**
 * The wait before the next request, given how many in a row have failed. A
 * blip should heal in seconds, not in the five minutes the poll waits; a real
 * outage should not be hammered.
 */
export function retryDelay(failures: number, pollMs: number): number {
  if (failures <= 0) return pollMs;
  return RETRY_STEPS_MS[failures - 1] ?? pollMs;
}

/**
 * Numbers each request so that only the newest one's answer is applied.
 * Paired in map-view.tsx with an AbortController, which saves the bandwidth
 * of a superseded request; the gate is what makes the ORDER right even when
 * the abort lands too late.
 */
export function requestGate(): { begin(): number; isLatest(n: number): boolean } {
  let latest = 0;
  return { begin: () => ++latest, isLatest: (n) => n === latest };
}

/**
 * The poll's next wait, or null for none at all. A background tab asks for
 * nothing: positions arrive every five minutes whether or not anyone is
 * looking, and coming back is a fresh load, not a wait for a timer.
 */
export function nextPollDelay(s: { failures: number; hidden: boolean }, pollMs: number): number | null {
  return s.hidden ? null : retryDelay(s.failures, pollMs);
}
