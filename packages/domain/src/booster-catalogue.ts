import { readFileSync } from "node:fs";
import { loadCatalogue, type Catalogue } from "./booster-kit";

/**
 * The committed catalogue, read from this package's own asset.
 *
 * ⚠️ Deliberately NOT re-exported from `src/index.ts`, and reached through
 * the `@factions/domain/catalogue` subpath instead. `@factions/domain` is in
 * `apps/web`'s `transpilePackages` and its root IS in the browser graph
 * (client components import `LINK_EMOTES`, `PIN_ICONS`, `nextRestartAt`), so
 * anything re-exported from the index reaches the client bundle. The
 * `node:fs` import below has no browser build: putting this module behind the
 * index would fail `next build` with a module-not-found for `fs`, and
 * nothing at typecheck or test time would catch it first.
 *
 * ⚠️ Lazy and memoised, for the same reason: a module-scope read would run on
 * import rather than on use, so merely resolving the module would touch the
 * disk in every process that reached it.
 */
const CATALOGUE_URL = new URL("../assets/booster-catalogue.json", import.meta.url);

let cached: Catalogue | null = null;

/**
 * Parse and validate the catalogue, once per process.
 *
 * ⚠️ Throws on a malformed catalogue rather than repairing — `loadCatalogue`
 * is the only validator of what a booster may pick, so a silently-dropped
 * slot would let the picker accept anything for it.
 */
export function boosterCatalogue(): Catalogue {
  if (cached === null) {
    cached = loadCatalogue(JSON.parse(readFileSync(CATALOGUE_URL, "utf8")));
  }
  return cached;
}
