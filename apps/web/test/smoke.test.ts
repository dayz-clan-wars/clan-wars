import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ⚠️ Every directory that can hold app code, not just `app/`. `src/` didn't
// exist when this test was written; a directory added later that isn't
// listed here is scanned by nothing, silently.
const ROOTS = [join(import.meta.dirname, "..", "app"), join(import.meta.dirname, "..", "src")];

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
  const sources = ROOTS.filter((root) => existsSync(root)).flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
      .map((f) => ({ file: join(root, f), text: readFileSync(join(root, f), "utf8") })),
  );

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
});
