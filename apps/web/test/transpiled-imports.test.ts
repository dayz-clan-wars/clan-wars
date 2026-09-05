import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠️ Every package listed in `apps/web/next.config.ts`'s `transpilePackages`
 * must use extensionless relative imports in its `src/` — Turbopack cannot
 * map `.js` -> `.ts`. A `.js` relative specifier surviving in a transpiled
 * package fails only at `next build`, after the package was added, with an
 * unhelpful module-not-found — nothing at typecheck or test time catches it
 * otherwise. See CLAUDE.md's convention note.
 */
const NEXT_CONFIG = readFileSync(join(import.meta.dirname, "..", "next.config.ts"), "utf8");

function transpiledPackages(source: string): string[] {
  const match = source.match(/transpilePackages\s*:\s*\[([^\]]*)\]/u);
  if (!match) return [];
  return [...match[1]!.matchAll(/["']@factions\/([^"']+)["']/gu)].map((m) => m[1]!);
}

const PACKAGE_NAMES = transpiledPackages(NEXT_CONFIG);
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

// A relative import/export/dynamic-import specifier ending in .js:
//   from "./foo.js" | from "../foo.js" | import("./foo.js")
const RELATIVE_JS_SPECIFIER = /(?:from\s+|import\()\s*["'](\.\.?\/[^"']*)\.js["']/gu;

describe("packages apps/web transpiles use extensionless relative imports", () => {
  it("finds at least one transpiled package to check", () => {
    expect(PACKAGE_NAMES.length).toBeGreaterThan(0);
  });

  for (const name of PACKAGE_NAMES) {
    const srcDir = join(REPO_ROOT, "packages", name, "src");
    const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
      .map((f) => join(srcDir, f));

    it(`@factions/${name} has source files`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files)(`@factions/${name}: %s has no ".js" relative specifier`, (file) => {
      const text = readFileSync(file, "utf8");
      const hits = [...text.matchAll(RELATIVE_JS_SPECIFIER)].map((m) => m[0]);
      expect(hits).toEqual([]);
    });
  }
});
