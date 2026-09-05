import type { NextConfig } from "next";

const config: NextConfig = {
  // ⚠️ Required by apps/web/Dockerfile. The standalone output is a
  // self-contained server directory; without it the runtime image would need
  // the whole pnpm workspace and its node_modules copied in.
  output: "standalone",

  // ⚠️ Every @factions/* package is raw TypeScript (`exports: "./src/index.ts"`),
  // not a built package. @factions/roster pulls in @factions/db and
  // @factions/domain transitively, so all three are listed — a missing one
  // fails `next build` on a package it doesn't know how to compile.
  transpilePackages: ["@factions/roster", "@factions/db", "@factions/domain", "@factions/declarations"],

  // postgres.js is a Node driver with no browser build; keep it external to
  // the server bundle rather than letting Next try to compile it.
  serverExternalPackages: ["postgres"],
};

export default config;
