import type { KitSlot } from "@factions/domain";

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

/** Looked up, never echoed: ?result= is attacker-supplied (lib/copy-lookup.ts). */
export const RESULT_COPY: Record<string, string> = {
  saved: "Saved. The new pick is in your kit from the next restart.",
  cleared: "Cleared. That slot will be empty from the next restart.",
  "bad-pick": "That item is not on the list for that slot, so nothing was saved. Pick one of the listed options.",
  "bad-slot": "That is not one of the nine slots, so nothing was saved.",
  "not-linked": "Link your character first. The spot is marked in game, so we need to know which character is yours.",
  // ⚠️ No number in this sentence. The count is LINK_EMOTES, a guide number in
  // rules.ts, and the page renders it from the sequence it was handed. A "three"
  // typed here would go on reading "three" after the constant changed, with
  // nothing failing: guide.test.ts scans guide chapters, not this file.
  drawn: "Your sequence is below. Go to the spot you want and perform the emotes in order.",
  "not-boosting": "Your kit is for server boosters. Nothing was saved.",
};

/** The three sentences the page must say plainly, wherever the kit is described. */
export const GROUND_RULES = [
  "The kit spawns on the ground where you marked it, in the open, as a pile of clothing.",
  "Anyone who finds it can take it. It is loot like any other loot.",
  "It comes back at the next restart, in the same spot, for as long as you keep boosting.",
] as const;
