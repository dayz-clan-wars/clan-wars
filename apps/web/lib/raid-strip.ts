import type { BaseDamageWindow } from "@factions/roster";

export type RaidStripLine = {
  label: string;
  value: string;
  detail: string;
  tone: "live" | "muted" | "warn";
};

/** "14h", "2d 0h", "38m" — coarse on purpose; a second-by-second clock invites reloading. */
export function humanizeUntil(from: Date, to: Date): string {
  const ms = Math.max(0, to.getTime() - from.getTime());
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

export function raidStripLine(w: BaseDamageWindow, now: Date): RaidStripLine {
  const label = "RAID WEEKEND";
  switch (w.status) {
    case "live":
      return { label, value: "LIVE", detail: `closes in ${humanizeUntil(now, w.closesAt)}`, tone: "live" };
    case "closed":
      return { label, value: "CLOSED", detail: `opens in ${humanizeUntil(now, w.opensAt)}`, tone: "muted" };
    case "skipped":
      return { label, value: "SKIPPED THIS WEEK", detail: w.skipReason ?? "", tone: "muted" };
    case "unconfirmed":
      // ⚠️ Never "LIVE" and never "CLOSED". The boundary has passed with no
      // confirmed flip, so the server's actual behaviour is unknown — stating
      // either is the confident lie this whole design exists to avoid.
      // ⚠️ State-aware: an unconfirmed CLOSE leaves base damage ON, so announcing
      // "OPENING" there would be the wrong word half the time — and the wrong
      // word in the direction that reads as reassurance.
      return {
        label,
        value: w.pending === "close" ? "CLOSING" : "OPENING",
        detail: "not yet confirmed",
        tone: "warn",
      };
  }
}
