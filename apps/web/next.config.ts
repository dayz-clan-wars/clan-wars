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
};

export default config;
