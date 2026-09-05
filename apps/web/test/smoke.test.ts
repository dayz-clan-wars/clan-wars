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
  // ⚠️ .mjs too: postcss.config.mjs and any future tailwind/next config in
  // that extension. This list has silently missed a new file twice already.
  .filter((f) => (f.endsWith(".ts") || f.endsWith(".mjs")) && !f.endsWith(".d.ts"))
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

  // ⚠️ next.config.ts must legitimately NAME @factions/db and postgres — in
  // transpilePackages (roster pulls db in transitively; raw-TS packages need
  // transpiling) and serverExternalPackages (postgres.js stays out of the
  // server bundle) — without that counting as the app IMPORTING them. Strip
  // just those two config-array declarations before scanning; an actual
  // `import ... from "@factions/db"` anywhere else still trips the check.
  const CONFIG_PACKAGE_LISTS = /\b(?:transpilePackages|serverExternalPackages)\s*:\s*\[[^\]]*\]/gu;
  const scannable = sources.map((s) => ({ file: s.file, text: s.text.replace(CONFIG_PACKAGE_LISTS, "") }));

  it.each(["@factions/db", "drizzle-orm", "postgres"])(
    "imports no database package (%s)", (pkg) => {
      const offenders = scannable.filter((s) => s.text.includes(`"${pkg}`) || s.text.includes(`'${pkg}`));
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

  it("⚠️ declarations cannot be written without evidence — the guard the capability rule will lean on", async () => {
    // Pinned here, in the web app's own suite, because this is the constraint
    // that makes "the site can never bind a pole from nothing" a property of
    // the database rather than of the export list. See spec §4.1 and §14.
    const sql = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations", "0020_declarations.sql"),
      "utf8",
    );
    expect(sql).toContain('CONSTRAINT "declarations_one_evidence"');
  });

  it("⚠️ never imports the roster's internal store — that entry point is the bot's (spec §5.4)", () => {
    const offenders = sources.filter((s) => s.text.includes("@factions/roster/internal"));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("⚠️ @factions/roster exports exactly the allowlist the site is permitted", async () => {
    // The capability rule (frontend rebuild §6; target spec §10.4). This is
    // the site's half of the pin; packages/roster/test/exports.test.ts is
    // the package's. Both must change for an export to land.
    const roster = await import("@factions/roster");
    expect(Object.keys(roster).sort()).toEqual(["DECLARE_SOLO_REASONS", "ISSUE_OUTCOME_KINDS", "baseFor", "cancelLink", "declareSolo", "linkStatus", "releaseSolo", "searchGamertags", "startLink", "unlink", "viewerFor"]);
  });
});
