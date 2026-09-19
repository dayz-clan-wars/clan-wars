/**
 * The nine slots a booster chooses. The tenth item in a kit is the clan
 * armband, which is DERIVED from the faction's texture (armbandFor) and is
 * deliberately not a slot: storing it would go stale the moment a clan
 * changes flag.
 */
export const KIT_SLOTS = ["mask", "eyewear", "hat", "jacket", "pants", "boots", "gloves", "hipPack", "backpack"] as const;
export type KitSlot = (typeof KIT_SLOTS)[number];

export type CatalogueEntry = { className: string; label: string; image?: string };
export type Catalogue = Record<KitSlot, CatalogueEntry[]>;

/**
 * Parse and check the committed catalogue.
 *
 * ⚠️ Throws rather than repairing. This file is the ONLY validator of what a
 * booster may pick; a silently-dropped slot would let the picker accept
 * anything for it, and a duplicate class name would render two identical
 * options a player cannot tell apart.
 */
export function loadCatalogue(json: unknown): Catalogue {
  const raw = json as Record<string, unknown>;
  const out = {} as Catalogue;
  for (const slot of KIT_SLOTS) {
    const list = raw?.[slot];
    if (!Array.isArray(list)) throw new Error(`booster catalogue: slot ${slot} is missing or not a list`);
    const seen = new Set<string>();
    const seenLabels = new Set<string>();
    for (const e of list as CatalogueEntry[]) {
      if (typeof e?.className !== "string" || typeof e?.label !== "string") {
        throw new Error(`booster catalogue: slot ${slot} has an entry without className and label`);
      }
      if (seen.has(e.className)) throw new Error(`booster catalogue: slot ${slot} lists ${e.className} twice`);
      seen.add(e.className);
      // ⚠️ A duplicate LABEL is the same failure as a duplicate class name —
      // two options a player cannot tell apart — and it is the one that
      // actually shipped: "Balaclava (White)" was on both Balaclava3Holes_White
      // and BalaclavaMask_White. Unique class names hid it completely.
      if (seenLabels.has(e.label)) throw new Error(`booster catalogue: slot ${slot} lists the label ${e.label} twice`);
      seenLabels.add(e.label);
      if (e.image !== undefined) {
        // ⚠️ Named after OUR class name, checked here rather than trusted: the
        // path is what the picker renders and what item-assets.test.ts pins
        // against public/items/, so a typo becomes a broken tile, not an error.
        if (typeof e.image !== "string" || e.image !== `items/${e.className}.webp`) {
          throw new Error(`booster catalogue: ${e.className} has image ${String(e.image)}, expected items/${e.className}.webp`);
        }
      }
    }
    out[slot] = list as CatalogueEntry[];
  }
  return out;
}

export function isAllowed(catalogue: Catalogue, slot: KitSlot, className: string): boolean {
  return catalogue[slot].some((e) => e.className === className);
}
