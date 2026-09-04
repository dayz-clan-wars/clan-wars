import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

// ⚠️ Every directory that can hold app code, not just `app/`. `src/` didn't
// exist when this test was written; `lib/` and the package root didn't exist
// when the auth code was added, and Next puts `middleware.ts` at the package
// ROOT — outside every directory this used to scan. A directory added later
// that isn't listed here is scanned by nothing, silently.
const ROOTS = [
  join(import.meta.dirname, "..", "app"),
  join(import.meta.dirname, "..", "src"),
  join(import.meta.dirname, "..", "lib"),
];

/** Root-level source files (middleware.ts, next.config.ts) — not a directory walk. */
const ROOT_FILES = readdirSync(join(import.meta.dirname, ".."), { encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => join(import.meta.dirname, "..", f));

/**
 * ⚠️ The site is a surface, never a source of truth (spec §3).
 *
 * This test used to be backed up by geography: the web app ran on a VPS with
 * no route to the database. It no longer is — `factions_live` is on the same
 * host now, one loopback port away. This test is the ONLY thing guarding
 * that now — the container is not a second guard: `web` and `postgres` share
 * the compose default network, so a hardcoded DSN in the web app would
 * connect fine regardless of the container boundary.
 *
 * It is not a substitute for the design decision; it is what makes the
 * decision expensive to reverse by accident.
 */
describe("the web app reads nothing", () => {
  const sources = [
    ...ROOTS.filter((root) => existsSync(root)).flatMap((root) =>
      readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
        .map((f) => join(root, f)),
    ),
    ...ROOT_FILES,
  ].map((file) => ({ file, text: readFileSync(file, "utf8") }));

  it("has source files to check", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(["@factions/db", "drizzle-orm", "postgres"])(
    "imports no database package (%s)", (pkg) => {
      const offenders = sources.filter((s) => s.text.includes(`"${pkg}`) || s.text.includes(`'${pkg}`));
      expect(offenders.map((o) => o.file)).toEqual([]);
    },
  );

  it("reads no DATABASE_URL", () => {
    const offenders = sources.filter((s) => s.text.includes("DATABASE_URL"));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("scans lib/ and the package root, where the auth code lives", () => {
    const scanned = sources.map((s) => s.file);
    expect(scanned.some((f) => f.includes(`${sep}lib${sep}auth${sep}cookies.ts`))).toBe(true);
  });
});
