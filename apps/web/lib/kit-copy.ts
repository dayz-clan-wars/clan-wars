import { KIT_SLOTS, type KitSlot } from "@factions/domain";

/**
 * The booster kit page's copy, in one place, the way base-copy.ts and
 * vault-copy.ts hold theirs.
 *
 * Voice rules for this page, from the design: plain sentences, no em dashes,
 * and nothing that frames the kit as protected. The kit is a pile of clothing
 * on the ground. Anyone who walks past it can take it, and it is back at the
 * next restart. Saying so plainly is the point: a player who thinks the spot
 * is defended will pick a worse one.
 */

/** What each of the nine slots is called on the page. Keyed by KIT_SLOTS. */
export const SLOT_LABELS: Record<KitSlot, string> = {
  mask: "Mask",
  eyewear: "Eyewear",
  hat: "Headgear",
  jacket: "Jacket",
  pants: "Pants",
  boots: "Boots",
  gloves: "Gloves",
  hipPack: "Hip pack",
  backpack: "Backpack",
};

/**
 * The nine tiles' reading order, which is NOT `KIT_SLOTS`.
 *
 * ⚠️ A separate list on purpose. `KIT_SLOTS` is the write layer's order (the
 * columns on `booster_kits`, the loop every save and every catalogue check
 * runs) and reordering it to suit a grid would silently reorder them all.
 * This is the 3x3 the design lays out: the pieces that decide whether a kit
 * is worth walking to on the top row, the small ones last. kit.test.ts pins
 * it as a permutation of KIT_SLOTS, so a slot can never be dropped from the
 * page by editing only this line.
 */
export const KIT_GRID_ORDER = [
  "jacket", "pants", "backpack",
  "hipPack", "boots", "gloves",
  "hat", "mask", "eyewear",
] as const satisfies readonly KitSlot[];

/** The three sentences the page must say plainly, wherever the kit is described. */
export const GROUND_RULES = [
  "The kit spawns on the ground where you marked it, in the open, as a pile of clothing.",
  "Anyone who finds it can take it. It is loot like any other loot.",
  "It comes back at the next restart, in the same spot, for as long as you keep boosting.",
] as const;

/**
 * Why a write was refused, as a sentence.
 *
 * ⚠️ Looked up, never echoed (lib/copy-lookup.ts). These now arrive as a
 * `reason` field in a JSON body rather than as `?result=`, which changes
 * nothing about the rule: the value still comes off the wire, still reaches a
 * property access, and a bare `RESULT_COPY[reason]` would still answer for
 * `__proto__`.
 */
export const RESULT_COPY: Record<string, string> = {
  "bad-pick": "That item is not on the list for that slot, so nothing was saved. Pick one of the listed options.",
  "bad-slot": "That is not one of the nine slots, so nothing was saved.",
  "not-linked": "Link your character first. The spot is marked in game, so we need to know which character is yours.",
  "not-boosting": "Your kit is for server boosters. Nothing was saved.",
  // The page saves as you pick, so a failed save is the one thing a player
  // cannot see for themselves. It says what is still true, not what broke.
  failed: "That did not save. Your last pick is still whatever it was before. Try it again.",
};

/**
 * The line under a pick, in the bar at the bottom of the screen.
 *
 * ⚠️ Says "Saved" because the write has already returned by the time it is
 * shown. A toast raised before the response would be a promise the page
 * cannot keep, and the Undo beside it would have nothing to undo yet.
 */
export function savedToast(slot: KitSlot, itemLabel: string | null): string {
  return itemLabel === null
    ? `${SLOT_LABELS[slot]} cleared. Saved.`
    : `${SLOT_LABELS[slot]} set to ${itemLabel}. Saved.`;
}

/** The count beside the grid: how many of the nine are filled. */
export const KIT_PIECES = KIT_SLOTS.length;
