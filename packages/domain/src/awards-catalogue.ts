import { loadAwards, type Awards, type AwardSlot } from "./awards";
import { KIT_GRID_ORDER, KIT_SLOT_LABELS, loadCatalogue } from "./booster-kit";
import raw from "../assets/awards.json";
import boosterRaw from "../assets/booster-catalogue.json";

/** The only `slotsFrom` value an award may name. */
const BOOSTER_SLOTS = "booster-catalogue";

/**
 * Fill every `"slotsFrom": "booster-catalogue"` entry with the booster kit's
 * nine slots, in the kit page's reading order.
 *
 * ⚠️ Derived, never copied into awards.json: the kit catalogue is ~200 items
 * that change as the mission's types.xml does, and a second copy would drift
 * from it the first time someone added a jacket to one and not the other. The
 * booster catalogue is validated by its own loader first, so a bad kit
 * catalogue stops the award catalogue too rather than slipping through.
 *
 * ⚠️ An unknown `slotsFrom` throws. Leaving it for `loadAwards` would report
 * "has no slots", which points at the wrong fix.
 */
function expandSlots(json: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(json)) {
    const { slotsFrom, ...rest } = entry;
    if (slotsFrom === undefined) { out[key] = entry; continue; }
    if (slotsFrom !== BOOSTER_SLOTS) throw new Error(`awards: ${key} has slotsFrom ${String(slotsFrom)}, expected ${BOOSTER_SLOTS}`);
    if (rest.slots !== undefined) throw new Error(`awards: ${key} has both slots and slotsFrom`);
    const kit = loadCatalogue(boosterRaw);
    const slots: Record<string, AwardSlot> = {};
    for (const slot of KIT_GRID_ORDER) slots[slot] = { label: KIT_SLOT_LABELS[slot], items: kit[slot] };
    out[key] = { ...rest, slots };
  }
  return out;
}

/**
 * The committed award catalogue, IMPORTED rather than read from disk, and
 * reached only through the `@factions/domain/awards` subpath.
 *
 * ⚠️ Both for `booster-catalogue.ts`'s reasons: a runtime file read is not
 * traced into the web container's standalone output, and the package index is
 * in the browser graph, so re-exporting this from `src/index.ts` would put the
 * catalogue in every visitor's download.
 *
 * ⚠️ Memoised validation. The worker and the bot call this at module scope so
 * a malformed catalogue stops them at startup, not on the first sweep.
 */
let cached: Awards | null = null;

export function awardsCatalogue(): Awards {
  if (cached === null) cached = loadAwards(expandSlots(raw as Record<string, Record<string, unknown>>));
  return cached;
}

/** Exported for the catalogue's own tests only. */
export { expandSlots as expandAwardSlots };
