import type { NextConfig } from "next";

const config: NextConfig = {
  // ⚠️ Required by apps/web/Dockerfile (Task 5). The standalone output is a
  // self-contained server directory; without it the runtime image would need
  // the whole pnpm workspace and its node_modules copied in.
  output: "standalone",

  // ⚠️ @factions/domain is raw TypeScript (`exports: "./src/index.ts"`), not a
  // built package. `next build` only succeeds today because nothing under
  // app/ imports it — tests and scripts/fetch-flags.ts are the only
  // importers. The first page or component that imports @factions/domain
  // will need `transpilePackages: ["@factions/domain"]` here, or the build
  // fails on a package it doesn't know how to compile.

  /**
   * ⚠️ Both prototypes already carry a `noindex` meta tag; this is the same
   * claim in a header, which a crawler sees without executing anything.
   *
   * ⚠️ Deliberately NOT a `Disallow` in robots.txt. Disallow blocks the FETCH,
   * and a crawler that never fetches the page never sees the noindex — a
   * blocked URL can still be indexed as a bare link if anything points at it.
   * Blocking would make these prototypes more likely to surface, not less.
   * Keep them crawlable so the refusal is the thing that gets read.
   */
  async headers() {
    const noindex = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];
    return [
      { source: "/mobile", headers: noindex },
      { source: "/mobile/:path*", headers: noindex },
      { source: "/link", headers: noindex },
      { source: "/link/:path*", headers: noindex },
    ];
  },
};

export default config;
