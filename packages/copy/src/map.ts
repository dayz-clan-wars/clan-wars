import type { PinIcon } from "@factions/domain";

/**
 * The wording a dropped pin can carry, and the labels for its icons. Kept
 * out of the client component so the copy is testable without a DOM.
 *
 * ⚠️ Nothing in here may ever interpolate a coordinate. The map's whole
 * privacy story (spec §10.3) is that the server-rendered HTML carries none
 * and the labels carry none either — ages, names, distances and grid refs
 * only.
 */

export const PIN_ICON_LABELS: Record<PinIcon, string> = { loot: "Loot", vehicle: "Vehicle", enemy: "Enemy seen", meet: "Meet here", danger: "Danger", note: "Note" };
/** The glyph for each icon is an SVG, not an emoji: `PIN_GLYPHS` in map-icons.ts. */

/**
 * ⚠️ One line per `DropPinOutcome` refusal reason, plus the two successes and
 * the delete that found nothing. A missing key is not an error — `lookupCopy`
 * misses and the player is redirected to a page that says nothing about why
 * their pin did not land. `map-copy.test.ts` lists the reasons as literals
 * and checks each one.
 */
export const PIN_RESULT_COPY: Record<string, string> = {
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
