import { loadAwards, type Awards } from "./awards";
import raw from "../assets/awards.json";

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
  if (cached === null) cached = loadAwards(raw);
  return cached;
}
