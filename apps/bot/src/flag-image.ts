import type { FlagImageResolver } from "./feed-embed.js";

/**
 * Fill `feed-embed.ts`'s resolver hook from configuration.
 *
 * ⚠️ Never fetches the URL to check it. A wrong base costs a missing
 * thumbnail and nothing else — Discord renders the embed without one. A
 * validating fetch would put a third-party network call between a faction
 * transition and its announcement, on the path whose first failure blocks the
 * whole feed queue by design.
 *
 * ⚠️ No alias table here. The wiki's one inconsistent filename (Sakhal) is
 * absorbed when the images are fetched, in apps/web — served files are always
 * named for our texture. A second table here would be the same fact stated
 * twice, and the two would drift.
 */
export function flagImageResolver(baseUrl: string | undefined): FlagImageResolver {
  if (!baseUrl) return () => null;
  // A base copied out of a browser usually carries a trailing slash.
  const base = baseUrl.replace(/\/+$/u, "");
  return (texture) => `${base}/flags/${texture}.png`;
}
