import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Inbox 37: the guide says "clan"; every string a player reads on the site
 * must too. Unlike the bot's vocabulary test this scans whole files, not just
 * string literals, because JSX text is not a string literal. Module
 * specifiers (`@factions/roster`) and comments are stripped first; anything
 * left that says faction is player-facing copy or an identifier that leaked
 * into copy — either way, a finding.
 */
const ROOTS = [join(import.meta.dirname, "..", "app")];
const MODULE_SPECIFIERS = /^\s*(?:import|export)\b[^;]*?\bfrom\s+["'][^"']+["'];?|^\s*import\s+["'][^"']+["'];?/gmu;
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|\{\/\*[\s\S]*?\*\/\}/gu;

const files = ROOTS.filter(existsSync).flatMap((root) =>
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => join(root, f)),
);

describe("site copy says clan, not faction", () => {
  it("has files to scan", () => expect(files.length).toBeGreaterThan(0));
  it.each(files)("%s", (file) => {
    const text = readFileSync(file, "utf8").replace(MODULE_SPECIFIERS, "").replace(COMMENTS, "");
    const hits = [...text.matchAll(/[^\n]*faction[^\n]*/giu)].map((m) => m[0].trim());
    expect(hits).toEqual([]);
  });
});
