import { PIN_ICONS, type PinIcon } from "@factions/domain";

/**
 * Every word the map says. Kept out of the client component so the copy is
 * testable without a DOM, and so the vocabulary test has one file to read.
 *
 * ⚠️ Nothing in here may ever interpolate a coordinate. The map's whole
 * privacy story (spec §10.3) is that the server-rendered HTML carries none
 * and the labels carry none either — ages, names, distances and grid refs
 * only.
 */

export const LAYER_LABELS = {
  you: "You", base: "Your base", clanmates: "Clanmates", intruders: "Intruders",
  publicBases: "Public bases", pins: "Pins", travel: "Travel points", terrain: "Terrain",
} as const;

export const PIN_ICON_LABELS: Record<PinIcon, string> = { loot: "Loot", vehicle: "Vehicle", enemy: "Enemy seen", meet: "Meet here", danger: "Danger", note: "Note" };
export const PIN_ICON_GLYPHS: Record<PinIcon, string> = { loot: "📦", vehicle: "🚙", enemy: "👁", meet: "📍", danger: "⚠️", note: "📝" };

/**
 * ⚠️ One line per `DropPinOutcome` refusal reason, plus the two successes and
 * the delete that found nothing. A missing key is not an error — `lookupCopy`
 * misses and the player is redirected to a page that says nothing about why
 * their pin did not land. `map-copy.test.ts` lists the reasons as literals
 * and checks each one.
 */
export const RESULT_COPY: Record<string, string> = {
  dropped: "Pin dropped. Everyone in the clan can see it for 7 days.",
  deleted: "Pin deleted.",
  "not-linked": "Link your character first — a pin is dropped by the character, not the Discord account.",
  "not-in-clan": "Pins are a clan thing. You are not in a clan.",
  pending: "Pins are for full members — go stand at the base first.",
  "bad-icon": "Pick one of the six icons.",
  "bad-note": "Notes are 140 characters at most.",
  "off-map": "That point is off the map.",
  "not-deleted": "That pin is not yours to delete, or it is already gone.",
};

/** "14 min ago", "3 h ago", "yesterday", "6 d ago" — the guide's own words for age. */
export function fixAge(at: Date, now: Date): string {
  const min = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} d ago`;
}

/** Past 24 h a dot is dimmed (guide ch. 10). */
export const DIM_AFTER_MS = 24 * 3600_000;

export { PIN_ICONS };
