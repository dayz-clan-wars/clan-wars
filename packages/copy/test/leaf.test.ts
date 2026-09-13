import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function tsFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? tsFiles(join(dir, e.name), rel) : e.name.endsWith(".ts") ? [rel] : [];
  });
}
const FILES = tsFiles(SRC);

/**
 * ⚠️ This package must stay a LEAF over `@factions/domain`. It may import
 * types from `@factions/roster` — those erase — but never a runtime value.
 *
 * The reason is not tidiness. `apps/web/lib/*-copy.ts` re-export this
 * package, and some of those shims are imported by CLIENT components
 * (`link-flow.tsx` is one). Because `src/index.ts` is a barrel, one runtime
 * import of `@factions/roster` anywhere in here puts that package's pooled
 * postgres client in the browser bundle of every page that touches any copy
 * table. Turbopack then fails the build with "Can't resolve 'fs'" — and
 * NOTHING in the gate catches it, because `tsc --noEmit` and vitest both
 * resolve modules the Node way and neither runs a bundler.
 *
 * That is exactly how the 2026-09-13 deploy broke: `vault.ts` imported
 * `VAULT_NAME_MAX`/`VAULT_NOTE_MAX` as values from `@factions/roster`, the
 * gate went 28/28 green, and the failure surfaced only when `next build` ran
 * inside the web image on the production host. Those two constants now live
 * in `@factions/domain` for this reason.
 *
 * If you need a runtime value that only `@factions/roster` has, the fix is to
 * move the value down into `@factions/domain`, not to relax this test.
 */
describe("@factions/copy is a leaf over @factions/domain", () => {
  it("finds the source files to check", () => {
    expect(FILES).toContain("vault.ts");
    expect(FILES.length).toBeGreaterThan(5);
  });

  for (const file of FILES) {
    it(`${file} imports no runtime value from @factions/roster`, () => {
      const src = readFileSync(join(SRC, file), "utf8");
      // Every `import ... from "@factions/roster"` statement in the file.
      // ⚠️ The clause must not be allowed to span a `from`, or a lazy match
      // starting at an EARLIER import runs on to this file's roster import and
      // reports that earlier statement's specifier list instead — which reads
      // as a failure in a file that is perfectly fine.
      const statements = [...src.matchAll(/import\s+((?:(?!\bfrom\b)[\s\S])*?)\s+from\s+["']@factions\/roster["']/gu)];
      for (const [, clause] of statements) {
        // `import type { ... }` erases entirely. Anything else is a runtime edge.
        expect(clause!.trimStart().startsWith("type "), `${file}: value import from @factions/roster — ${clause!.replace(/\s+/gu, " ").trim()}`).toBe(true);
      }
    });
  }

  it("declares @factions/roster as a dev dependency only", () => {
    const pkg = JSON.parse(readFileSync(resolve(SRC, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@factions/roster");
    expect(Object.keys(pkg.devDependencies ?? {})).toContain("@factions/roster");
  });
});
