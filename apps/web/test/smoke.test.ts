import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dirname, "..", "app");

/**
 * ⚠️ The site is a surface, never a source of truth (spec §3). It is also
 * deployable today ONLY because it reads nothing — `factions_live` lives on a
 * different machine from the VPS, so a database import here would not fail at
 * review, it would fail at runtime in production.
 *
 * This test is the cheap structural guard on both. It is not a substitute for
 * the design decision; it is what makes the decision expensive to reverse by
 * accident.
 */
describe("the web app reads nothing", () => {
  const sources = readdirSync(APP, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => ({ file: f, text: readFileSync(join(APP, f), "utf8") }));

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
