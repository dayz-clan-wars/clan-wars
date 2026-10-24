/**
 * The reads heard so far, kept in this browser so a trip to the map (or a
 * sign-in on the way there) doesn't throw away minutes of listening.
 *
 * Reads, not cards: a later listen votes on top of them, so a code half heard
 * before the map can settle after it. Only the ten-character reads are kept,
 * never audio, and nothing here leaves the device.
 */
import type { Read } from "./decode";

const KEY = "clan-wars:radio-reads:v1";
/** Two hours after the last new read (Steve): long enough for a raid trip, short enough not to greet tomorrow night with tonight's codes. */
export const KEEP_MS = 2 * 60 * 60 * 1000;

type Stored = { savedAt: number; reads: string[] };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const READ = /^[0-9?]{10}$/;

/** The kept reads, or none when there are none, they are stale, or the store is unreadable. */
export function loadReads(store: Store | null, now: number): Read[] {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return [];
    const got = JSON.parse(raw) as Partial<Stored>;
    if (typeof got.savedAt !== "number" || !Array.isArray(got.reads) || now - got.savedAt > KEEP_MS) {
      store?.removeItem(KEY);
      return [];
    }
    return got.reads.filter((r): r is string => typeof r === "string" && READ.test(r)).map((digits) => ({ digits }));
  } catch {
    return [];
  }
}

/** Keep `reads`, stamped `now`; none removes the entry. A private window or a full store just doesn't keep them. */
export function saveReads(store: Store | null, reads: Read[], now: number): void {
  try {
    if (reads.length === 0) store?.removeItem(KEY);
    else store?.setItem(KEY, JSON.stringify({ savedAt: now, reads: reads.map((r) => r.digits) } satisfies Stored));
  } catch {
    // Not kept; the page still works for as long as it stays open.
  }
}

/** localStorage, or null where touching it throws (some private windows, blocked site data). */
export function browserStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
