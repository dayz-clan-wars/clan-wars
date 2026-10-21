import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WEB = join(import.meta.dirname, "..");

/**
 * ⚠️ apps/web/Dockerfile copies only packages/ and apps/web/, and `next build`
 * type-checks whatever tsconfig.build.json includes. v2.8.0 failed to deploy
 * because scripts/item-sources.ts imports the ingest worker's source, which the
 * image does not have. These tests hold the Dockerfile, the build tsconfig and
 * the app's imports together; nothing else does, and CI never runs `next build`.
 */
describe("the web image can build what next build checks", () => {
  it("next build uses tsconfig.build.json", () => {
    expect(readFileSync(join(WEB, "next.config.ts"), "utf8")).toMatch(/tsconfigPath:\s*"tsconfig\.build\.json"/u);
  });

  it("tsconfig.build.json leaves out scripts/ and test/", () => {
    const text = readFileSync(join(WEB, "tsconfig.build.json"), "utf8").replace(/^\s*\/\/.*$/gmu, "");
    const exclude = (JSON.parse(text) as { exclude: string[] }).exclude;
    expect(exclude).toEqual(expect.arrayContaining(["scripts", "test"]));
  });

  it("no app file imports another app's source", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "scripts", "test", "public"].includes(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/u.test(name) && /from\s+["'](\.\.\/)+(apps\/|ingest-worker|bot|show)\//u.test(readFileSync(path, "utf8"))) {
          offenders.push(relative(WEB, path));
        }
      }
    };
    walk(WEB);
    expect(offenders).toEqual([]);
  });
});
