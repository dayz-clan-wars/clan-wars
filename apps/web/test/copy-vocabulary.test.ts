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
// ⚠️ Same roots smoke.test.ts scans — src/ and lib/ can carry player-facing
// copy too (see apps/web/src/flag-images.ts), and a directory left off this
// list is scanned by nothing, silently.
const ROOTS = [
  join(import.meta.dirname, "..", "app"),
  join(import.meta.dirname, "..", "src"),
  join(import.meta.dirname, "..", "lib"),
];
const MODULE_SPECIFIERS = /^\s*(?:import|export)\b[^;]*?\bfrom\s+["'][^"']+["'];?|^\s*import\s+["'][^"']+["'];?/gmu;
// A bare `//` inside a URL (`https://...`) is not a comment marker — it must
// be at line start or preceded by whitespace to count as one, or a one-line
// JSX with a URL and copy on the same line (`<a href="https://x">faction</a>`)
// has everything after the URL's `//` silently deleted before the scan runs.
const COMMENTS = /\/\*[\s\S]*?\*\/|(?:^|(?<=\s))\/\/[^\n]*|\{\/\*[\s\S]*?\*\/\}/gu;

function strip(text: string): string {
  return text.replace(MODULE_SPECIFIERS, "").replace(COMMENTS, "");
}

const files = ROOTS.filter(existsSync).flatMap((root) =>
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => join(root, f)),
);

describe("site copy says clan, not faction", () => {
  it("has files to scan", () => expect(files.length).toBeGreaterThan(0));

  it("does not treat a URL's // as a comment marker", () => {
    expect(strip('<a href="https://x.y">Found a faction here</a>')).toContain("faction");
  });

  it("still strips a real line comment", () => {
    expect(strip("const a = 1; // faction comment")).not.toContain("faction");
  });

  it.each(files)("%s", (file) => {
    const text = strip(readFileSync(file, "utf8"));
    const hits = [...text.matchAll(/[^\n]*faction[^\n]*/giu)].map((m) => m[0].trim());
    expect(hits).toEqual([]);
  });
});
