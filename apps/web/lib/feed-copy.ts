import type { FeedEntry } from "@factions/roster";

/** The kicker word for each kind of feed line, and its colour class. */
export const FEED_KIND: Record<FeedEntry["kind"], { label: string; tone: string }> = {
  kill: { label: "Kill", tone: "text-gold" },
  death: { label: "Death", tone: "text-rust-2" },
  raid: { label: "Raid", tone: "text-gold" },
  raised: { label: "Colours", tone: "text-olive" },
  built: { label: "Building", tone: "text-olive" },
  dismantled: { label: "Dismantle", tone: "text-muted" },
};

export const EMPTY_FEED = "Nothing in the log for this scope.";
export const FEED_TITLE = "Feed";
export const FRIENDLY_FIRE_MARK = "friendly fire";

/**
 * What the log called a killer-less death — the adm parser's `DeathCause`,
 * plus `pvp`, which the kills consumer writes on a self-kill. `died` is the
 * parser's "no cause on the line" and reads as nothing more. An unknown value
 * is shown as the log wrote it.
 */
export const DEATH_CAUSE: Record<string, string> = {
  bled_out: "bled out",
  drowned: "drowned",
  suicide: "by their own hand",
  pvp: "by their own hand",
  infected: "to the infected",
  animal: "to an animal",
  fall: "from a fall",
  vehicle: "under a vehicle",
  environment: "to the environment",
  died: "",
};
export const deathCause = (cause: string | null): string => (cause === null ? "" : DEATH_CAUSE[cause] ?? cause);

/** "12 build steps", "1 build step". */
export const steps = (n: number, verb: "built" | "dismantled"): string =>
  `${verb === "built" ? "Built" : "Dismantled"} ${n} ${n === 1 ? "step" : "steps"}`;

/** "193.6 m · DMR", "DMR", "193.6 m", or nothing. */
export const shot = (distanceM: number | null, weapon: string | null): string =>
  [distanceM === null ? null : `${distanceM} m`, weapon].filter(Boolean).join(" · ");
