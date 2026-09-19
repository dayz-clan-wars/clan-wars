import { loadCatalogue, type Catalogue } from "./booster-kit";
import raw from "../assets/booster-catalogue.json";

/**
 * The committed catalogue, IMPORTED as a module rather than read from disk.
 *
 * ⚠️ It used to be a runtime `readFileSync` of the asset through
 * `new URL(..., import.meta.url)`, and that is broken in production. `/kit`
 * is `force-dynamic`, so the read happens on every request inside the web
 * container, whose runtime image copies only `.next/standalone`. A successful
 * `next build` proves nothing about that: Next's file tracing did NOT pull
 * `packages/domain/assets/booster-catalogue.json` into the standalone output,
 * confirmed empirically on 2026-09-19 by building the image and finding no
 * such file anywhere in it. `/kit` threw ENOENT on every request while every
 * other page was fine. An import makes the data part of the bundle, so there
 * is nothing left to trace.
 *
 * ⚠️ Still deliberately NOT re-exported from `src/index.ts`, and still
 * reached through the `@factions/domain/catalogue` subpath. `@factions/domain`
 * is in `apps/web`'s `transpilePackages` and its root IS in the browser graph
 * (client components import `LINK_EMOTES`, `PIN_ICONS`, `nextRestartAt`), so
 * anything re-exported from the index reaches the client bundle. The reason
 * changed with the read: it is no longer `node:fs` that would break the build,
 * it is the catalogue's own weight landing in every visitor's download.
 *
 * ⚠️ Lazy and memoised VALIDATION, for what is left of the original reason:
 * `loadCatalogue` is not free, and the ingest worker calls `boosterCatalogue()`
 * at module scope on purpose so a malformed catalogue stops it at startup.
 * The import itself is eager now, which is the point.
 */
let cached: Catalogue | null = null;

/**
 * Parse and validate the catalogue, once per process.
 *
 * ⚠️ Throws on a malformed catalogue rather than repairing — `loadCatalogue`
 * is the only validator of what a booster may pick, so a silently-dropped
 * slot would let the picker accept anything for it.
 */
export function boosterCatalogue(): Catalogue {
  if (cached === null) cached = loadCatalogue(raw);
  return cached;
}
